import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@jest/globals";
import { DEFAULT_CONFIG } from "./config.ts";
import { buildRouteContext, classifyRoute, extractText, isValidSkillName, MAX_PICKS, parsePicks, parseSource, reasoningFor, ROUTER_FRAMING, shouldRoute } from "./skills.ts";

const skills = ["a", "b", "c", "d"].map((name) => ({ name, description: `about ${name}\n  wrapped` }));

describe("buildRouteContext", () => {
	it("lists skills one per line and wraps the prompt", () => {
		const ctx = buildRouteContext(skills, "fix it");
		expect(ctx.systemPrompt).toBe(ROUTER_FRAMING);
		const text = (ctx.messages[0].content as { text: string }[])[0].text;
		expect(text).toContain("<skills>\na: about a wrapped\nb: about b wrapped\n");
		expect(text).toContain("<user_prompt>\nfix it\n</user_prompt>");
	});
});

describe("parsePicks", () => {
	it("keeps known names only", () => {
		expect(parsePicks("<picked>b, zzz</picked>", skills)?.map((s) => s.name)).toEqual(["b"]);
		expect(parsePicks("<picked>\na\nc\n</picked>", skills)?.map((s) => s.name)).toEqual(["a", "c"]);
	});
	it("accepts an empty pick and caps the count", () => {
		expect(parsePicks("<picked></picked>", skills)).toEqual([]);
		expect(parsePicks("<picked>a,b,c,d</picked>", skills)).toHaveLength(MAX_PICKS);
	});
	it("uses the last tag pair and rejects missing tags", () => {
		expect(parsePicks("e.g. <picked>a</picked> then <picked>d</picked>", skills)?.map((s) => s.name)).toEqual(["d"]);
		expect(parsePicks("no tags", skills)).toBeUndefined();
	});
});

describe("parseSource", () => {
	it("treats local paths as paths", () => {
		expect(parseSource("./skills/debug")).toEqual({ kind: "path", path: "./skills/debug" });
		expect(parseSource("/abs/dir")).toEqual({ kind: "path", path: "/abs/dir" });
		expect(parseSource("~/x")).toEqual({ kind: "path", path: "~/x" });
	});
	it("expands github shorthand and git: hosts", () => {
		expect(parseSource("user/repo")).toEqual({ kind: "git", url: "https://github.com/user/repo" });
		expect(parseSource("user/repo@v1")).toEqual({ kind: "git", url: "https://github.com/user/repo", ref: "v1" });
		expect(parseSource("git:gitlab.com/a/b")).toEqual({ kind: "git", url: "https://gitlab.com/a/b" });
	});
	it("keeps explicit urls and splits refs", () => {
		expect(parseSource("https://github.com/a/b.git")).toEqual({ kind: "git", url: "https://github.com/a/b.git" });
		expect(parseSource("https://github.com/a/b@main")).toEqual({ kind: "git", url: "https://github.com/a/b", ref: "main" });
		expect(parseSource("git@github.com:a/b.git")).toEqual({ kind: "git", url: "git@github.com:a/b.git" });
		expect(parseSource("git@github.com:a/b@dev")).toEqual({ kind: "git", url: "git@github.com:a/b", ref: "dev" });
	});
});

describe("parseSource edge cases", () => {
	it("does not treat a URL username as a ref", () => {
		expect(parseSource("https://user@host.com/a/b")).toEqual({ kind: "git", url: "https://user@host.com/a/b" });
		expect(parseSource("ssh://git@host/a/b")).toEqual({ kind: "git", url: "ssh://git@host/a/b" });
		expect(parseSource("ssh://git@host/a/b@v2")).toEqual({ kind: "git", url: "ssh://git@host/a/b", ref: "v2" });
	});
	it("accepts refs with slashes", () => {
		expect(parseSource("user/repo@feature/x")).toEqual({ kind: "git", url: "https://github.com/user/repo", ref: "feature/x" });
		expect(parseSource("https://github.com/a/b@release/1.2")).toEqual({ kind: "git", url: "https://github.com/a/b", ref: "release/1.2" });
		expect(parseSource("git@github.com:a/b@feature/y")).toEqual({ kind: "git", url: "git@github.com:a/b", ref: "feature/y" });
	});
	it("adds https to host:port sources", () => {
		expect(parseSource("git:gitlab.com:2222/a/b")).toEqual({ kind: "git", url: "https://gitlab.com:2222/a/b" });
	});
	it("prefers existing local paths and .md files over github shorthand", () => {
		expect(parseSource("skills/debug", (p) => p === "skills/debug")).toEqual({ kind: "path", path: "skills/debug" });
		expect(parseSource("docs/SKILL.md")).toEqual({ kind: "path", path: "docs/SKILL.md" });
		expect(parseSource("skills/debug", () => false)).toEqual({ kind: "git", url: "https://github.com/skills/debug" });
	});
	it("rejects sources and refs that git would read as options", () => {
		expect(() => parseSource("git:--upload-pack=x")).toThrow("invalid git source");
		expect(() => parseSource("user/repo@-x")).toThrow("invalid git ref");
		for (const bad of ["a..b", "a//b", "x.lock", "v1/", "v1."]) expect(() => parseSource(`user/repo@${bad}`)).toThrow("invalid git ref");
	});
});

describe("isValidSkillName", () => {
	it("accepts pi-style names", () => {
		expect(isValidSkillName("systematic-debugging")).toBe(true);
		expect(isValidSkillName("a1")).toBe(true);
	});
	it("rejects traversal, uppercase, bad hyphens, and long names", () => {
		for (const bad of ["../x", "..", "a/b", "Foo", "-a", "a-", "a--b", "", "a".repeat(65)]) expect(isValidSkillName(bad)).toBe(false);
	});
});

describe("parseSource shorthand with ref", () => {
	it("checks local existence without the @ref suffix", () => {
		expect(parseSource("user/repo@v1", (p) => p === "user/repo")).toEqual({ kind: "path", path: "user/repo@v1" });
	});
});

describe("shouldRoute", () => {
	const on = { skillRouting: true };
	const user = { messageType: "user", prompt: "fix it" };
	it("routes plain user prompts", () => {
		expect(shouldRoute(true, user, on)).toBe(true);
	});
	it("skips non-user, image, skill and disabled cases", () => {
		expect(shouldRoute(false, user, on)).toBe(false);
		expect(shouldRoute(true, { ...user, messageType: "custom" }, on)).toBe(false);
		expect(shouldRoute(true, { ...user, images: [{}] }, on)).toBe(false);
		expect(shouldRoute(true, { ...user, prompt: '<skill name="a">' }, on)).toBe(false);
		expect(shouldRoute(true, user, { skillRouting: false })).toBe(false);
	});
});

describe("classifyRoute", () => {
	const ok = { stopReason: "stop", text: "<picked>a, b</picked>" };
	it("returns picks on success", () => {
		expect(classifyRoute(ok, skills, false, false, 30000)).toEqual({ kind: "ok", picked: skills.slice(0, 2) });
	});
	it("prefers cancel over timeout", () => {
		expect(classifyRoute(ok, skills, true, true, 30000)).toEqual({ kind: "cancelled" });
	});
	it("reports timeout", () => {
		expect(classifyRoute(ok, skills, false, true, 30000)).toEqual({ kind: "failed", error: "timed out after 30s" });
	});
	it("reports non-stop reasons", () => {
		expect(classifyRoute({ stopReason: "error", errorMessage: "boom", text: "" }, skills, false, false, 30000)).toEqual({ kind: "failed", error: "boom" });
		expect(classifyRoute({ stopReason: "length", text: "" }, skills, false, false, 30000)).toEqual({ kind: "failed", error: "stopped: length" });
	});
	it("reports missing picked tags", () => {
		expect(classifyRoute({ stopReason: "stop", text: "a" }, skills, false, false, 30000)).toEqual({ kind: "failed", error: "no <picked> output" });
	});
});

describe("reasoningFor", () => {
	it("maps off to undefined and passes others through", () => {
		expect(reasoningFor({ ...DEFAULT_CONFIG, thinking: "off" })).toBeUndefined();
		expect(reasoningFor({ ...DEFAULT_CONFIG, thinking: "high" })).toBe("high");
	});
});

describe("extractText", () => {
	it("joins text parts and ignores thinking", () => {
		const msg = { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "<picked>a" }, { type: "text", text: "</picked>" }] } as unknown as AssistantMessage;
		expect(extractText(msg)).toBe("<picked>a</picked>");
	});
});

describe("parseSource extras", () => {
	it("trims whitespace and expands shorthand to GitHub", () => {
		expect(parseSource("  user/repo  ")).toEqual({ kind: "git", url: "https://github.com/user/repo" });
	});
	it("keeps plain https urls and refs", () => {
		expect(parseSource("https://github.com/a/b")).toEqual({ kind: "git", url: "https://github.com/a/b" });
		expect(parseSource("git:github.com/a/b@v1")).toEqual({ kind: "git", url: "https://github.com/a/b", ref: "v1" });
	});
	it("rejects an empty git source", () => {
		expect(() => parseSource("git:")).toThrow("invalid git source");
	});
});
