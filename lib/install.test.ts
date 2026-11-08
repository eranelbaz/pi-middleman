import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@jest/globals";
import { installInto, overlaps, planInstall, skillName } from "./install.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "mm-install-"));
const ref = (name: string, baseDir: string, file = "SKILL.md") => ({ name, baseDir, filePath: join(baseDir, file) });
const skillAt = (dir: string, body = "skill") => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), body);
	return dir;
};

describe("skillName", () => {
	it("prefers frontmatter, then the folder for SKILL.md, then the file name", () => {
		expect(skillName("/r/debug/SKILL.md", "named")).toBe("named");
		expect(skillName("/r/debug/SKILL.md", undefined)).toBe("debug");
		expect(skillName("/tmp/repo/plans.md", "")).toBe("plans");
	});
});

describe("planInstall", () => {
	it("skips invalid names, symlinked skills, and later duplicates", () => {
		const root = tmp();
		const a = skillAt(join(root, "a"));
		const b = skillAt(join(root, "b"));
		symlinkSync(a, join(root, "linked"));
		const plan = planInstall([ref("a", a), ref("../evil", a), ref("a", b), ref("linked", join(root, "linked")), ref("b", b)], root);
		expect(plan.install.map((s) => s.name)).toEqual(["a", "b"]);
		expect(plan.skipped).toEqual(["../evil (invalid name)", "a (duplicate)", "linked (symlink)"]);
	});
});

describe("planInstall containment", () => {
	it("skips skills reached through a symlinked parent folder", () => {
		const outside = skillAt(join(tmp(), "secret"));
		const root = tmp();
		symlinkSync(join(outside, ".."), join(root, "link"));
		const plan = planInstall([ref("secret", join(root, "link", "secret"))], root);
		expect(plan.install).toEqual([]);
		expect(plan.skipped).toEqual(["secret (symlink)"]);
	});
});

describe("installInto", () => {
	it("copies a skill folder without dotfiles, node_modules, symlinks, or nested skills", () => {
		const src = skillAt(tmp(), "root");
		writeFileSync(join(src, "notes.md"), "n");
		writeFileSync(join(src, ".env"), "SECRET=1");
		mkdirSync(join(src, ".git"));
		mkdirSync(join(src, "node_modules"));
		skillAt(join(src, "nested"), "nested");
		symlinkSync("/etc/hosts", join(src, "link"));
		const target = tmp();
		installInto(target, [ref("root", src)], [ref("root", src), ref("nested", join(src, "nested"))]);
		expect(readFileSync(join(target, "root", "SKILL.md"), "utf8")).toBe("root");
		expect(existsSync(join(target, "root", "notes.md"))).toBe(true);
		for (const gone of [".env", ".git", "node_modules", "nested", "link"]) expect(existsSync(join(target, "root", gone))).toBe(false);
	});
	it("installs a loose .md file as SKILL.md and replaces an existing install", () => {
		const src = tmp();
		writeFileSync(join(src, "debug.md"), "loose");
		const target = tmp();
		skillAt(join(target, "debug"), "old");
		writeFileSync(join(target, "debug", "old.txt"), "old");
		installInto(target, [ref("debug", src, "debug.md")], []);
		expect(readFileSync(join(target, "debug", "SKILL.md"), "utf8")).toBe("loose");
		expect(existsSync(join(target, "debug", "old.txt"))).toBe(false);
	});
	it("refuses a source inside the target and leaves it intact", () => {
		const target = tmp();
		const installed = skillAt(join(target, "foo"), "keep");
		expect(() => installInto(target, [ref("foo", installed)], [])).toThrow("overlaps");
		expect(readFileSync(join(installed, "SKILL.md"), "utf8")).toBe("keep");
	});
	it("changes nothing when a copy fails partway", () => {
		const target = tmp();
		skillAt(join(target, "a"), "old-a");
		const good = skillAt(join(tmp(), "a"), "new-a");
		const broken = tmp();
		expect(() => installInto(target, [ref("a", good), ref("b", broken)], [])).toThrow("SKILL.md was not copied");
		expect(readFileSync(join(target, "a", "SKILL.md"), "utf8")).toBe("old-a");
		expect(readdirSync(target)).toEqual(["a"]);
	});
});

describe("overlaps", () => {
	it("detects nesting in either direction and ignores siblings", () => {
		const root = tmp();
		const a = skillAt(join(root, "a"));
		const b = skillAt(join(root, "b"));
		const inner = skillAt(join(a, "inner"));
		expect(overlaps(a, inner)).toBe(true);
		expect(overlaps(inner, a)).toBe(true);
		expect(overlaps(a, a)).toBe(true);
		expect(overlaps(a, b)).toBe(false);
	});
});

describe("installInto extras", () => {
	it("installs several skills and leaves no staging folder behind", () => {
		const target = tmp();
		const src = tmp();
		installInto(target, [ref("a", skillAt(join(src, "a"), "A")), ref("b", skillAt(join(src, "b"), "B"))], []);
		expect(readdirSync(target).sort()).toEqual(["a", "b"]);
		expect(readFileSync(join(target, "b", "SKILL.md"), "utf8")).toBe("B");
	});
	it("creates the target directory when missing", () => {
		const target = join(tmp(), "nested", "skills");
		installInto(target, [ref("a", skillAt(join(tmp(), "a")))], []);
		expect(existsSync(join(target, "a", "SKILL.md"))).toBe(true);
	});
});
