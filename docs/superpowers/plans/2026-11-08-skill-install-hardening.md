# Middleman Skill Install Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/middleman-skill install|remove` safe and correct: source parsing, unsafe names, what gets copied, atomic overwrite, git and no-UI failure modes.
**Architecture:** Pure logic lives in `lib/` so Jest can test it without pi (Jest can't resolve `@earendil-works/pi-coding-agent`, so `lib/` must not import its runtime values). `lib/skills.ts` gets source parsing + name validation; new `lib/install.ts` does naming, install planning, and a staged, atomic copy using only `node:fs`. `extensions/middleman.ts` keeps discovery (pi's `loadSkillsFromDir`/`parseFrontmatter`), git, and UI.
**Tech Stack:** TypeScript (ESM, `.ts` imports), Jest via `@swc/jest`, Node ≥20.3, `@earendil-works/pi-coding-agent` 1.4.0.
**Spec:** this document (from review of PoC commit `dbe18c7` on branch `feat/skill-routing`, plus a hardcore stress-test; two stress-test rounds; all code below verified in a scratch copy: `tsc` clean, 77/77 tests).

## Global Constraints

- Tabs, no comments, match existing style. Tests import from `@jest/globals`. `npm test` and `npm run check` pass after every task.
- `lib/*.ts` may `import type` from pi packages but must not import runtime values from `@earendil-works/pi-coding-agent`.
- Valid skill name: `/^[a-z0-9]+(-[a-z0-9]+)*$/`, ≤ 64 chars (pi's own rule, enforced here instead of only warned).
- Install never writes or deletes outside `target`; a source that overlaps `target` (same, inside, or containing, by realpath) is refused.
- Install is all-or-nothing: copies are staged in `target/.staging-*`; existing skills are moved aside only after every copy succeeded, and restored if any swap fails.
- Never copied: symlinks, dotfiles/dot-dirs (incl. `.git`, `.env`), `node_modules`, folders of other discovered skills. A skill whose `SKILL.md`/`.md` file or folder is a symlink, or whose real path is outside the source root (symlinked parent), is skipped and reported.
- Loose `.md` skills without a frontmatter `name` are named after the file (`plans.md` → `plans`), never the parent dir.
- `@ref` is recognised only after the repo path starts (never in `user@host`); refs match `/^[\w.][\w./-]*$/` (slashes allowed) and must not contain `..` or `//` nor end in `.lock`, `/` or `.`; sources/refs that start with `-` are rejected; git gets `--` before the URL.
- `user/repo` shorthand applies only when nothing exists at that relative path under `cwd` and it doesn't end in `.md`.
- Git: `GIT_TERMINAL_PROMPT=0`, one shared 120 000 ms deadline across all git calls, errors show redacted stderr only (never the argv), temp dir removed in `finally`.
- Do not commit `nohup.out`.

## File Structure

- `lib/skills.ts` — rewrite `parseSource`, add `isValidSkillName`.
- `lib/skills.test.ts` — tests for both.
- `lib/install.ts` (new) — `SkillRef`, `skillName`, `planInstall`, `overlaps`, `installInto`.
- `lib/install.test.ts` (new) — temp-dir tests.
- `extensions/middleman.ts` — `installSkills` on top of `lib/install.ts`, git helper, `remove` validation.
- `README.md` — install wording.

---

### Task 1: Source parsing and name validation

**Files:**
- Modify: `lib/skills.ts` (replace the `parseSource` function at the end; keep `SkillSource`)
- Test: `lib/skills.test.ts`

**Interfaces:**
- Produces: `parseSource(raw: string, exists?: (relPath: string) => boolean): SkillSource` (default `() => false`; throws `Error("invalid git source …")` / `Error("invalid git ref …")`), `isValidSkillName(name: string): boolean`.

- [ ] **Step 1: Write failing tests** — change the import line to `import { buildRouteContext, isValidSkillName, MAX_PICKS, parsePicks, parseSource, ROUTER_FRAMING } from "./skills.ts";` and append:

```ts
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
```

- [ ] **Step 2: Run, verify fails** — `npx jest lib/skills.test.ts`: FAIL (`isValidSkillName` not a function; username, port, `.md`, option-injection, and invalid-ref cases wrong). The "accepts refs with slashes" test, `ssh://git@host/a/b@v2`, and the `() => false` shorthand assertion already pass — they are regression guards.

- [ ] **Step 3: Implement** — replace the existing `parseSource` function in `lib/skills.ts` with:

```ts
const REF = /^[\w.][\w./-]*$/;

export function parseSource(raw: string, exists: (relPath: string) => boolean = () => false): SkillSource {
	const src = raw.trim();
	const git = src.startsWith("git:") ? src.slice(4) : /^(https?|ssh|git):\/\/|^git@/.test(src) ? src : undefined;
	if (git === undefined) {
		const shorthand = /^\w[\w.-]*\/[\w.-]+(@[\w./-]+)?$/.test(src) && !/\.md$/i.test(src) && !exists(src);
		return shorthand ? parseSource(`git:github.com/${src}`) : { kind: "path", path: src };
	}
	const scheme = git.indexOf("://");
	const pathStart = scheme !== -1 ? git.indexOf("/", scheme + 3) : /^[^/]+@[^/:]+:/.test(git) ? git.indexOf(":") + 1 : git.indexOf("/");
	const at = pathStart === -1 ? -1 : git.indexOf("@", pathStart);
	const base = at === -1 ? git : git.slice(0, at);
	const ref = at === -1 ? undefined : git.slice(at + 1);
	if (!base || base.startsWith("-")) throw new Error(`invalid git source "${raw}"`);
	if (ref !== undefined && (!REF.test(ref) || /\.\.|\/\/|\.lock$|[./]$/.test(ref))) throw new Error(`invalid git ref "${ref}"`);
	const url = /^[\w.-]+\.\w+(:\d+)?\//.test(base) ? `https://${base}` : base;
	return { kind: "git", url, ...(ref && { ref }) };
}

export function isValidSkillName(name: string): boolean {
	return name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}
```

- [ ] **Step 4: Run, verify passes** — `npm test && npm run check`. All pass, including the pre-existing `parseSource` tests.

- [ ] **Step 5: Commit**

```bash
git add lib/skills.ts lib/skills.test.ts
git commit -m "fix: skill source parsing edge cases, add skill name validation"
```

---

### Task 2: Safe, atomic install primitives

**Files:**
- Create: `lib/install.ts`
- Test: `lib/install.test.ts`

**Interfaces:**
- Consumes: `isValidSkillName` (Task 1).
- Produces:
  - `type SkillRef = { name: string; filePath: string; baseDir: string }`
  - `skillName(filePath: string, declared: unknown): string` — frontmatter name if non-empty string, else folder name for `SKILL.md`, else file name without `.md`.
  - `planInstall(found: SkillRef[], root: string): { install: SkillRef[]; skipped: string[] }` — `skipped` entries are `"<name> (invalid name|symlink|duplicate)"`, first occurrence wins; "symlink" also covers skills whose real path is outside `root` (reached through a symlinked parent).
  - `overlaps(a: string, b: string): boolean` — realpath containment either way.
  - `installInto(target: string, skills: SkillRef[], others: SkillRef[]): void` — throws `"<src> overlaps <target>"` before touching anything; stages all copies, then swaps them in.

- [ ] **Step 1: Write failing tests** — create `lib/install.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@jest/globals";
import { installInto, planInstall, skillName } from "./install.ts";

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
```

- [ ] **Step 2: Run, verify fails** — `npx jest lib/install.test.ts`: FAIL "Cannot find module './install.ts'".

- [ ] **Step 3: Implement** — create `lib/install.ts`:

```ts
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isValidSkillName } from "./skills.ts";

export type SkillRef = { name: string; filePath: string; baseDir: string };

const isSkillMd = (s: SkillRef) => basename(s.filePath) === "SKILL.md";
const sourceOf = (s: SkillRef) => (isSkillMd(s) ? s.baseDir : s.filePath);
const copied = (name: string) => !name.startsWith(".") && name !== "node_modules";

function contains(parent: string, child: string): boolean {
	const rel = relative(realpathSync(parent), realpathSync(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function skillName(filePath: string, declared: unknown): string {
	if (typeof declared === "string" && declared) return declared;
	return basename(filePath) === "SKILL.md" ? basename(dirname(filePath)) : basename(filePath).replace(/\.md$/i, "");
}

export function planInstall(found: SkillRef[], root: string): { install: SkillRef[]; skipped: string[] } {
	const install: SkillRef[] = [];
	const skipped: string[] = [];
	for (const skill of found) {
		if (!isValidSkillName(skill.name)) skipped.push(`${skill.name} (invalid name)`);
		else if (lstatSync(skill.filePath).isSymbolicLink() || lstatSync(sourceOf(skill)).isSymbolicLink() || !contains(root, sourceOf(skill))) {
			skipped.push(`${skill.name} (symlink)`);
		}
		else if (install.some((s) => s.name === skill.name)) skipped.push(`${skill.name} (duplicate)`);
		else install.push(skill);
	}
	return { install, skipped };
}

export function overlaps(a: string, b: string): boolean {
	return contains(a, b) || contains(b, a);
}

export function installInto(target: string, skills: SkillRef[], others: SkillRef[]): void {
	mkdirSync(target, { recursive: true });
	for (const skill of skills) {
		if (overlaps(target, sourceOf(skill))) throw new Error(`${sourceOf(skill)} overlaps ${target}`);
	}
	const staging = mkdtempSync(join(target, ".staging-"));
	try {
		for (const skill of skills) {
			const dest = join(staging, skill.name);
			if (isSkillMd(skill)) {
				const base = resolve(skill.baseDir);
				const nested = new Set(others.map((s) => resolve(s.baseDir)).filter((d) => d !== base));
				cpSync(base, dest, {
					recursive: true,
					filter: (p) => p === base || (copied(basename(p)) && !lstatSync(p).isSymbolicLink() && !nested.has(resolve(p))),
				});
			} else {
				mkdirSync(dest);
				cpSync(skill.filePath, join(dest, "SKILL.md"));
			}
			if (!existsSync(join(dest, "SKILL.md"))) throw new Error(`${skill.name}: SKILL.md was not copied`);
		}
		const moved: string[] = [];
		try {
			for (const skill of skills) {
				const dest = join(target, skill.name);
				if (existsSync(dest)) renameSync(dest, join(staging, `.old-${skill.name}`));
				moved.push(skill.name);
				renameSync(join(staging, skill.name), dest);
			}
		} catch (e) {
			for (const name of moved.reverse()) {
				rmSync(join(target, name), { recursive: true, force: true });
				if (existsSync(join(staging, `.old-${name}`))) renameSync(join(staging, `.old-${name}`), join(target, name));
			}
			throw e;
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
```

- [ ] **Step 4: Run, verify passes** — `npm test && npm run check`.

- [ ] **Step 5: Commit**

```bash
git add lib/install.ts lib/install.test.ts
git commit -m "feat: safe, atomic skill install primitives"
```

---

### Task 3: Wire hardened install into the extension

**Files:**
- Modify: `extensions/middleman.ts` — imports at the top, the whole `installSkills` function (currently between `loadRoutedSkills` and `skillBlock`), the `middleman-skill` command handler.
- Modify: `README.md` — the `/middleman-skill` block and the paragraph after it in "Skill routing".

**Interfaces:**
- Consumes: `parseSource`, `isValidSkillName` (Task 1); `installInto`, `planInstall`, `SkillRef`, `skillName` (Task 2).
- Produces: `installSkills(ctx: ExtensionContext, source: string, target: string): Promise<{ names: string[]; skipped: string[] }>` (the `pi` parameter is dropped).

No unit tests (the extension can't load under Jest); verification is `npm run check`, `npm test`, and the smoke test in Step 4.

- [ ] **Step 1: Replace `installSkills`** (delete the old function entirely) with:

```ts
const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const SHA = /^[0-9a-f]{7,40}$/i;
const redact = (s: string) => s.replace(/\/\/[^/@\s]+@/g, "//***@");

async function git(args: string[], signal: AbortSignal, cwd?: string): Promise<void> {
	try {
		await execFileAsync("git", args, { cwd, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
	} catch (e) {
		if (signal.aborted) throw new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s`);
		const stderr = (e as { stderr?: string }).stderr?.trim();
		throw new Error(`git ${args[0]} failed${stderr ? `: ${redact(stderr)}` : ""}`);
	}
}

function findSkills(root: string): { found: SkillRef[]; problems: string[] } {
	if (statSync(root).isFile()) {
		let frontmatter: { name?: unknown; description?: unknown };
		try {
			frontmatter = parseFrontmatter<{ name?: unknown; description?: unknown }>(readFileSync(root, "utf8")).frontmatter;
		} catch (e) {
			return { found: [], problems: [`${root}: invalid frontmatter: ${(e as Error).message}`] };
		}
		if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) return { found: [], problems: [`${root}: missing description`] };
		return { found: [{ name: skillName(root, frontmatter.name), filePath: root, baseDir: dirname(root) }], problems: [] };
	}
	const { skills, diagnostics } = loadSkillsFromDir({ dir: root, source: "middleman" });
	const found = skills.map((s) => {
		if (basename(s.filePath) === "SKILL.md") return s;
		const { frontmatter } = parseFrontmatter<{ name?: unknown }>(readFileSync(s.filePath, "utf8"));
		return { ...s, name: skillName(s.filePath, frontmatter.name) };
	});
	return { found, problems: diagnostics.map((d) => `${d.path ?? root}: ${d.message}`) };
}

async function installSkills(ctx: ExtensionContext, source: string, target: string): Promise<{ names: string[]; skipped: string[] }> {
	const src = parseSource(source, (p) => existsSync(resolvePath(ctx.cwd, p)));
	const tmp = src.kind === "git" ? mkdtempSync(join(tmpdir(), "middleman-skill-")) : undefined;
	try {
		let root: string;
		if (src.kind === "path") {
			root = resolvePath(ctx.cwd, src.path.replace(/^~(?=$|\/)/, homedir()));
			if (!existsSync(root)) throw new Error(`${root} does not exist`);
		} else {
			root = join(tmp as string, "repo");
			const signal = AbortSignal.timeout(GIT_TIMEOUT_MS);
			if (src.ref && SHA.test(src.ref)) {
				await git(["clone", "--filter=blob:none", "--no-checkout", "--", src.url, root], signal);
				await git(["checkout", src.ref, "--"], signal, root);
			} else {
				await git(["clone", "--depth", "1", ...(src.ref ? ["--branch", src.ref] : []), "--", src.url, root], signal);
			}
		}
		const { found, problems } = findSkills(root);
		const { install, skipped } = planInstall(found, statSync(root).isFile() ? dirname(root) : root);
		if (!install.length) throw new Error(`no installable skills found${[...skipped, ...problems].length ? `: ${[...skipped, ...problems].join("; ")}` : ""}`);
		const clashes = install.filter((s) => existsSync(join(target, s.name))).map((s) => s.name);
		if (clashes.length) {
			if (!ctx.hasUI) throw new Error(`already installed: ${clashes.join(", ")} (remove first)`);
			if (!(await ctx.ui.confirm("Overwrite skills?", `Already installed: ${clashes.join(", ")}`))) throw new Error("cancelled, nothing installed");
		}
		installInto(target, install, found);
		return { names: install.map((s) => s.name), skipped };
	} finally {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	}
}
```

Imports, exactly:
- `node:fs` → `import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";` (`cpSync`/`mkdirSync` are no longer used; `rg -n "cpSync|mkdirSync" extensions/middleman.ts` must return nothing).
- add `import { execFile } from "node:child_process";` and `import { promisify } from "node:util";`
- add `parseFrontmatter` to the `@earendil-works/pi-coding-agent` import list (alphabetical, after `loadSkillsFromDir`).
- add `import { installInto, planInstall, type SkillRef, skillName } from "../lib/install.ts";`
- skills import becomes `import { buildRouteContext, isValidSkillName, parsePicks, parseSource } from "../lib/skills.ts";`

- [ ] **Step 2: Update the handler**
  - `remove`: condition `basename(arg) !== arg || !existsSync(join(dest, "SKILL.md"))` → `!isValidSkillName(arg) || !existsSync(join(dest, "SKILL.md"))`.
  - `install`: `const names = await installSkills(pi, ctx, arg, target);` → `const { names, skipped } = await installSkills(ctx, arg, target);` and the message → `` `Installed ${names.join(", ")} to ${target}${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}${routing}` ``.

- [ ] **Step 3: README** — in the `/middleman-skill` code block: `optional @ref` → `optional @branch, @tag or @commit`; `# local folder or single .md file` → `# local path (prefix ./ if it looks like user/repo)`. Replace the paragraph starting "Add `--project`" with:

```text
Add `--project` to install into or remove from the project folder. Install finds every skill in the source (folders with `SKILL.md` using pi's discovery rules, or `.md` files with a `description` in their frontmatter) and copies each into its own folder named after the skill (frontmatter `name`, else the folder or file name), asking before overwriting; headless runs refuse to overwrite, so remove first. Nothing is replaced unless every skill copied successfully. Skill names must be lowercase letters, digits and single hyphens; invalid, duplicate, and symlinked skills are skipped and listed. Dotfiles (including `.env` and `.git`), `node_modules`, and symlinks are never copied, and a source inside the skills folder is refused. Git sources are cloned to a temp dir that is deleted afterwards, with credential prompts disabled and a 120 second limit; there is no update command yet, so reinstall to update.
```

- [ ] **Step 4: Verify** — `npm test && npm run check`, then this real-discovery smoke test (no pi session needed):

```bash
rm -rf /tmp/mmsrc /tmp/mmtgt && mkdir -p /tmp/mmsrc/skills/debug && cd /tmp/mmsrc \
 && printf -- '---\nname: debug\ndescription: debug things\n---\nbody\n' > skills/debug/SKILL.md \
 && printf -- '---\ndescription: plans\n---\nP\n' > plans.md \
 && printf -- '---\ndescription: review\n---\nR\n' > review.md && echo S > .env \
 && cd /Users/eranelbaz/projects/pi-middleman && node --experimental-strip-types -e '
import("@earendil-works/pi-coding-agent").then(async (m) => {
  const fs = await import("node:fs");
  const { installInto, planInstall, skillName } = await import("./lib/install.ts");
  const found = m.loadSkillsFromDir({ dir: "/tmp/mmsrc", source: "x" }).skills.map((s) => s.filePath.endsWith("SKILL.md") ? s : { ...s, name: skillName(s.filePath, m.parseFrontmatter(fs.readFileSync(s.filePath, "utf8")).frontmatter.name) });
  const plan = planInstall(found, "/tmp/mmsrc");
  installInto("/tmp/mmtgt", plan.install, found);
  console.log(fs.readdirSync("/tmp/mmtgt").sort(), plan.skipped);
})'
```

Expected: `[ 'debug', 'plans', 'review' ] []`.

- [ ] **Step 5: Commit**

```bash
git add extensions/middleman.ts README.md
git commit -m "fix: harden /middleman-skill install and remove"
```
