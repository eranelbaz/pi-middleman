import { describe, expect, it } from "@jest/globals";
import { buildRouteContext, MAX_PICKS, parsePicks, parseSource, ROUTER_FRAMING } from "./skills.ts";

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
