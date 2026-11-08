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
				try {
					rmSync(join(target, name), { recursive: true, force: true });
					if (existsSync(join(staging, `.old-${name}`))) renameSync(join(staging, `.old-${name}`), join(target, name));
				} catch {}
			}
			throw e;
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
