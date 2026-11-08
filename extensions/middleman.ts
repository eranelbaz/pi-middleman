import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	getAgentDir,
	getSelectListTheme,
	loadSkillsFromDir,
	parseFrontmatter,
	ProjectTrustStore,
	type Skill,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import {
	type Layer,
	type MiddlemanConfig,
	mergeLayers,
	patchLayer,
	readLayer,
	SCOPES,
	type Scope,
	sourceOf,
	THINKING_LEVELS,
} from "../lib/config.ts";
import { installInto, planInstall, type SkillRef, skillName } from "../lib/install.ts";
import { buildRouteContext, classifyRoute, extractText, isValidSkillName, parseSource, reasoningFor, shouldRoute } from "../lib/skills.ts";

const GLOBAL_PATH = join(getAgentDir(), "middleman.json");
const GLOBAL_SKILLS = join(getAgentDir(), "middleman-skills");
const SKILLS_TYPE = "middleman-skills";
const SKILL_TOOL = "middleman_skill";
const ROUTE_TIMEOUT_MS = 20_000;

type Layers = Partial<Record<Scope, Layer>>;
type Model = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

function projectPath(ctx: ExtensionContext): string | undefined {
	if (!ctx.isProjectTrusted()) return undefined;
	try {
		if (realpathSync(ctx.cwd) === realpathSync(homedir())) return undefined;
		if (new ProjectTrustStore(getAgentDir()).get(ctx.cwd) !== true) return undefined;
	} catch {
		return undefined;
	}
	return join(ctx.cwd, ".pi", "middleman.json");
}

function resolveModel(ctx: ExtensionContext, cfg: MiddlemanConfig): Model | undefined {
	return cfg.provider && cfg.model ? ctx.modelRegistry.find(cfg.provider, cfg.model) : undefined;
}

type Route = { kind: "ok"; picked: Skill[] } | { kind: "failed"; error: string } | { kind: "cancelled" };

async function routeSkills(ctx: ExtensionContext, model: Model, cfg: MiddlemanConfig, skills: Skill[], prompt: string, cancel?: AbortSignal): Promise<Route> {
	const timeout = AbortSignal.timeout(ROUTE_TIMEOUT_MS);
	const signal = cancel ? AbortSignal.any([cancel, timeout]) : timeout;
	try {
		const res = await ctx.modelRegistry
			.streamSimple(model, buildRouteContext(skills, prompt), { signal, maxRetries: 0, reasoning: reasoningFor(cfg) })
			.result();
		return classifyRoute({ ...res, text: extractText(res) }, skills, !!cancel?.aborted, timeout.aborted, ROUTE_TIMEOUT_MS);
	} catch (e) {
		if (cancel?.aborted) return { kind: "cancelled" };
		if (timeout.aborted) return { kind: "failed", error: `timed out after ${ROUTE_TIMEOUT_MS / 1000}s` };
		return { kind: "failed", error: e instanceof Error ? e.message : String(e) };
	}
}

function routeWithLoader(ctx: ExtensionContext, model: Model, cfg: MiddlemanConfig, skills: Skill[], prompt: string): Promise<Route> {
	return ctx.ui.custom<Route>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Middleman picking skills with ${cfg.provider}/${cfg.model}... (esc to skip)`);
		loader.onAbort = () => done({ kind: "cancelled" });
		routeSkills(ctx, model, cfg, skills, prompt, loader.signal).then(done);
		return loader;
	});
}

function loadRoutedSkills(dirs: string[]): Skill[] {
	const byName = new Map<string, Skill>();
	for (const dir of dirs) {
		for (const skill of loadSkillsFromDir({ dir, source: "middleman" }).skills) {
			if (!byName.has(skill.name)) byName.set(skill.name, skill);
		}
	}
	return [...byName.values()];
}

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
		return { names: install.map((s) => s.name), skipped: [...skipped, ...problems] };
	} finally {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	}
}

function skillBlock(skill: Skill): string {
	const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

const NAV_KEYS = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;

async function pick(ctx: ExtensionContext, title: string, labels: string[], current?: string): Promise<string | undefined> {
	if (ctx.mode !== "tui") return ctx.ui.select(title, labels);
	return ctx.ui.custom<string | undefined>((tui, theme, kb, done) => {
		const items: SelectItem[] = labels.map((label) => ({ value: label, label }));
		const search = new Input();
		search.focused = true;
		const root = new Container();
		root.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
		root.addChild(search);
		root.addChild(new Spacer(1));
		const listIndex = root.children.length;
		const build = (shown: SelectItem[], preselect?: string) => {
			const list = new SelectList(shown, Math.min(Math.max(shown.length, 1), 10), getSelectListTheme());
			const i = shown.findIndex((item) => item.value === preselect);
			if (i !== -1) list.setSelectedIndex(i);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			return list;
		};
		const empty = new Text(theme.fg("muted", "No matches"), 1, 0);
		let list = build(items, current);
		root.addChild(list);
		root.addChild(new Spacer(1));
		root.addChild(new Text(theme.fg("dim", "Type to filter · ↑↓ move · Enter select · Esc back"), 1, 0));
		return Object.assign(root, {
			handleInput(data: string) {
				if (NAV_KEYS.some((k) => kb.matches(data, k))) {
					list.handleInput(data);
					return;
				}
				search.handleInput(data);
				const query = search.getValue();
				const shown = query ? fuzzyFilter(items, query, (item) => item.label) : items;
				list = build(shown, query ? undefined : current);
				root.children[listIndex] = shown.length ? list : empty;
				tui.requestRender();
			},
		});
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer<{ names: string[] }>(SKILLS_TYPE, (message, { expanded }, theme) => {
		const names = message.details?.names ?? [];
		const body = expanded && typeof message.content === "string" ? `\n${message.content}` : "";
		return new Text(`${theme.fg("accent", "✦ ")}${theme.fg("dim", `middleman loaded skills: ${names.join(", ")}`)}${body}`, 1, 0);
	});

	let session: Layer = {};
	let project: { path: string; layer?: Layer; error?: string } | undefined;
	const loadProject = (ctx: ExtensionContext) => {
		const path = projectPath(ctx);
		if (!path) return void (project = undefined);
		try {
			project = { path, layer: readLayer(path) };
		} catch (e) {
			project = { path, error: (e as Error).message };
		}
	};
	const resolve = () => {
		const layers: Layers = { session, ...(project?.layer && { project: project.layer }), global: readLayer(GLOBAL_PATH) };
		return { cfg: mergeLayers(SCOPES.map((s) => layers[s] ?? {})), layers, projectError: project?.error };
	};

	const showStatus = (ctx: ExtensionContext, cfg?: MiddlemanConfig, layers?: Layers) => {
		if (!cfg) return ctx.ui.setStatus("middleman", "mm:config error");
		const proj = layers?.project && Object.keys(layers.project).length ? " [proj]" : "";
		ctx.ui.setStatus("middleman", cfg.skillRouting ? `mm:${cfg.model ?? "?"}${proj}` : undefined);
	};
	const refreshStatus = (ctx: ExtensionContext) => {
		try {
			const { cfg, layers, projectError } = resolve();
			showStatus(ctx, projectError ? undefined : cfg, layers);
		} catch {
			showStatus(ctx, undefined);
		}
	};

	const warned = new Set<string>();
	const warnOnce = (ctx: ExtensionContext, key: string, message: string) => {
		if (warned.has(key)) return;
		warned.add(key);
		ctx.ui.notify(message, "warning");
	};

	pi.on("session_start", async (_event, ctx) => {
		warned.clear();
		session = {};
		loadProject(ctx);
		refreshStatus(ctx);
		syncSkillTool(ctx);
	});

	const skillDirs = () => ({
		...(project && !project.error && { project: join(dirname(project.path), "middleman-skills") }),
		global: GLOBAL_SKILLS,
	});

	pi.registerCommand("middleman-skill", {
		description: "Manage middleman skills: install <source> [--project] | list | remove <name> [--project]",
		getArgumentCompletions: (prefix) => {
			const [sub, ...rest] = prefix.split(/\s+/);
			if (rest.length) return null;
			return ["install", "list", "remove"].filter((c) => c.startsWith(sub)).map((c) => ({ value: `${c} `, label: c }));
		},
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const scoped = words.includes("--project");
			const [sub, arg] = words.filter((w) => w !== "--project");
			const dirs = skillDirs();
			const target = scoped ? dirs.project : dirs.global;
			if (scoped && !target) return ctx.ui.notify("Project skills need a repo you explicitly trusted in pi (not your home dir)", "error");
			if (sub === "list") {
				const lines = Object.entries(dirs).flatMap(([scope, dir]) =>
					loadSkillsFromDir({ dir, source: "middleman" }).skills.map((s) => `${s.name} (${scope}) — ${s.description.replace(/\s+/g, " ").slice(0, 80)}`),
				);
				return ctx.ui.notify(lines.length ? lines.join("\n") : `No middleman skills. Install with /middleman-skill install <source>`, "info");
			}
			if (sub === "remove" && arg && target) {
				const dest = join(target, arg);
				if (!isValidSkillName(arg) || !existsSync(join(dest, "SKILL.md"))) return ctx.ui.notify(`No skill "${arg}" in ${target}`, "error");
				rmSync(dest, { recursive: true, force: true });
				return ctx.ui.notify(`Removed middleman skill ${arg}`, "info");
			}
			if (sub === "install" && arg && target) {
				try {
					const { names, skipped } = await installSkills(ctx, arg, target);
					let routing = " (turn on Skill routing in /middleman to use them)";
					try {
						if (resolve().cfg.skillRouting) routing = "";
					} catch {}
					ctx.ui.notify(`Installed ${names.join(", ")} to ${target}${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}${routing}`, "info");
				} catch (e) {
					ctx.ui.notify(`Skill install failed: ${(e as Error).message}`, "error");
				}
				return;
			}
			ctx.ui.notify("Usage: /middleman-skill install <git-url|user/repo|path> [--project] | list | remove <name> [--project]", "error");
		},
	});

	pi.registerCommand("middleman", {
		description: "Configure the middleman skill router",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/middleman requires interactive mode", "error");
				return;
			}
			const show = {
				skillRouting: (c: Layer) => (c.skillRouting ? "on" : "off"),
				model: (c: Layer) => (c.provider && c.model ? `${c.provider}/${c.model}` : "(not set)"),
				thinking: (c: Layer) => `${c.thinking}`,
			};
			const write = (scope: Scope, patch: Layer) => {
				if (scope === "session") {
					session = Object.fromEntries(Object.entries({ ...session, ...patch }).filter(([, v]) => v !== undefined));
				} else if (scope === "project") {
					if (!project) throw new Error("project config is not available");
					patchLayer(project.path, patch);
					loadProject(ctx);
				} else patchLayer(GLOBAL_PATH, patch);
			};
			let scope: Scope = "global";
			let last: string | undefined;
			while (true) {
				const scopes = SCOPES.filter((s) => s !== "project" || (project && !project.error));
				if (!scopes.includes(scope)) scope = "global";
				let state: ReturnType<typeof resolve>;
				try {
					state = resolve();
				} catch (e) {
					ctx.ui.notify(`Fix or delete the config first: ${(e as Error).message}`, "error");
					return;
				}
				const { cfg, layers, projectError } = state;
				const own = layers[scope] ?? {};
				const label = (name: string, key: keyof typeof show) => {
					const s = sourceOf(key, layers);
					const shadowed = own[key] !== undefined && show[key](own) !== show[key](cfg) ? ` · ${scope}: ${show[key](own)}` : "";
					return `${name}: ${show[key](cfg)}${s === "default" ? "" : ` (${s})`}${shadowed}`;
				};
				const items = {
					...(projectError && { broken: `⚠ project config broken: ${projectError} (select to re-read)` }),
					scope: `Editing: ${scope}`,
					skillRouting: label("Skill routing", "skillRouting"),
					model: label("Model", "model"),
					thinking: label("Thinking", "thinking"),
					...(Object.keys(own).length && { clear: `Clear ${scope} overrides` }),
				};
				const choice = await pick(ctx, "Middleman", Object.values(items), last && (items as Record<string, string | undefined>)[last]);
				const key = (Object.keys(items) as (keyof typeof items)[]).find((k) => items[k] === choice);
				if (!key) break;
				last = key;
				if (key === "broken") {
					warned.delete("config:project");
					loadProject(ctx);
					refreshStatus(ctx);
					continue;
				}
				if (key === "scope") {
					if (!project) ctx.ui.notify("Project scope needs a repo you explicitly trusted in pi (not your home dir)", "info");
					const s = await pick(ctx, "Apply changes to", scopes, scope);
					scope = scopes.find((x) => x === s) ?? scope;
					continue;
				}
				let patch: Layer = {};
				if (key === "skillRouting") patch = { skillRouting: !(own.skillRouting ?? cfg.skillRouting) };
				if (key === "clear") patch = Object.fromEntries(Object.keys(own).map((k) => [k, undefined]));
				if (key === "thinking") {
					const t = await pick(ctx, "Thinking effort", THINKING_LEVELS, own.thinking ?? cfg.thinking);
					const level = THINKING_LEVELS.find((l) => l === t);
					if (level) patch = { thinking: level };
				}
				if (key === "model") {
					const models = ctx.modelRegistry.getAvailable();
					if (!models.length) {
						ctx.ui.notify("No models with working auth — log in to a provider first", "warning");
						continue;
					}
					const labels = models.map((x) => `${x.provider}/${x.id}`);
					const cur = own.provider ? own : cfg;
					const m = await pick(ctx, "Middleman model", labels, `${cur.provider}/${cur.model}`);
					const chosen = m === undefined ? undefined : models[labels.indexOf(m)];
					if (chosen) patch = { provider: chosen.provider, model: chosen.id };
				}
				const keys = Object.keys(patch) as (keyof MiddlemanConfig)[];
				if (keys.every((k) => own[k] === patch[k])) continue;
				let after: ReturnType<typeof resolve>;
				try {
					write(scope, patch);
					after = resolve();
				} catch (e) {
					ctx.ui.notify(`Could not save middleman config: ${(e as Error).message}`, "error");
					break;
				}
				for (const k of keys) {
					const s = sourceOf(k, after.layers);
					if (patch[k] !== undefined && s !== "default" && SCOPES.indexOf(s) < SCOPES.indexOf(scope)) {
						ctx.ui.notify(`${k} is overridden by the ${s} config`, "warning");
					}
				}
				if (after.cfg.skillRouting && !after.cfg.model) ctx.ui.notify("Pick a model or skills will not be loaded", "warning");
				for (const k of warned) if (k.startsWith("model:")) warned.delete(k);
				refreshStatus(ctx);
			}
		},
	});

	let routeNext = false;
	pi.on("input", async (event, ctx) => {
		routeNext = !event.streamingBehavior && event.source !== "extension";
		const userPrompt = routeNext && !event.text.startsWith("/");
		try {
			const { cfg, layers, projectError } = resolve();
			if (projectError) {
				showStatus(ctx, undefined);
				if (userPrompt) warnOnce(ctx, "config:project", `Middleman config unreadable, skipping skill routing: ${projectError}`);
			} else showStatus(ctx, cfg, layers);
		} catch (e) {
			showStatus(ctx, undefined);
			if (userPrompt) warnOnce(ctx, "config:global", `Middleman config unreadable, skipping skill routing: ${(e as Error).message}`);
		}
		return { action: "continue" };
	});
	const routingConfig = (): MiddlemanConfig | undefined => {
		try {
			const state = resolve();
			return state.projectError || !state.cfg.skillRouting ? undefined : state.cfg;
		} catch {
			return undefined;
		}
	};
	const newBlocks = (ctx: ExtensionContext, picked: Skill[]) => {
		const loaded = new Set(
			ctx.sessionManager.buildContextEntries().flatMap((e) => {
				if (e.type === "custom_message" && e.customType === SKILLS_TYPE) return (e.details as { names?: string[] })?.names ?? [];
				if (e.type === "message" && e.message.role === "toolResult" && e.message.toolName === SKILL_TOOL) return (e.message.details as { names?: string[] })?.names ?? [];
				return [];
			}),
		);
		return picked.filter((s) => !loaded.has(s.name)).flatMap((s) => {
			try {
				return [{ name: s.name, block: skillBlock(s) }];
			} catch (e) {
				ctx.ui.notify(`Middleman could not read skill ${s.name}: ${(e as Error).message}`, "warning");
				return [];
			}
		});
	};

	pi.registerTool({
		name: SKILL_TOOL,
		label: "Middleman skill",
		description:
			"Ask the middleman for skills (step-by-step instructions for specific tools, services and workflows) matching a need that came up mid-task, e.g. 'create a Linear issue' or 'write a database migration'. Returns the matching skills' instructions, or says none apply.",
		promptSnippet: "Load skills for a need that comes up mid-task",
		promptGuidelines: [
			`Before using an external service or unfamiliar workflow (issue trackers, deploys, APIs) or searching MCP tools for it, call ${SKILL_TOOL} with the need; follow any skill it returns.`,
		],
		parameters: Type.Object({ need: Type.String({ description: "What you are about to do, in a short phrase" }) }),
		async execute(_id, { need }, signal, onUpdate, ctx) {
			const text = (t: string, names: string[] = []) => ({ content: [{ type: "text" as const, text: t }], details: { names } });
			if (!need.trim()) return text("Describe the need in a short phrase.");
			const cfg = routingConfig();
			if (!cfg) return text("Middleman skill routing is off; no skills available.");
			const model = resolveModel(ctx, cfg);
			if (!model) return text("Middleman has no valid model configured; no skills available.");
			const skills = loadRoutedSkills(Object.values(skillDirs()));
			if (!skills.length) return text("No middleman skills are installed.");
			onUpdate?.(text(`Middleman picking skills for "${need}"...`));
			const res = await routeSkills(ctx, model, cfg, skills, need, signal);
			if (res.kind === "cancelled") throw new Error("cancelled");
			if (res.kind === "failed") return text(`Middleman skill routing failed (${res.error}). Proceed without skills; don't retry.`);
			if (!res.picked.length) return text(`No skill matches "${need}". Proceed without one.`);
			const blocks = newBlocks(ctx, res.picked);
			const already = res.picked.filter((s) => !blocks.some((b) => b.name === s.name)).map((s) => s.name);
			const note = already.length ? `Already loaded earlier in this conversation (follow them): ${already.join(", ")}` : "";
			if (!blocks.length && !note) return text("Matching skills could not be read. Proceed without them.");
			return text([...blocks.map((b) => b.block), note].filter(Boolean).join("\n\n"), blocks.map((b) => b.name));
		},
	});

	const syncSkillTool = (ctx: ExtensionContext) => {
		const cfg = routingConfig();
		const usable = !!cfg && !!resolveModel(ctx, cfg) && loadRoutedSkills(Object.values(skillDirs())).length > 0;
		const active = pi.getActiveTools();
		if (usable === active.includes(SKILL_TOOL)) return;
		pi.setActiveTools(usable ? [...active, SKILL_TOOL] : active.filter((t) => t !== SKILL_TOOL));
	};

	pi.on("before_agent_start", async (event, ctx) => {
		syncSkillTool(ctx);
		const fromUser = routeNext;
		routeNext = false;
		if (event.messageType !== "user" || !shouldRoute(fromUser, event, { skillRouting: true })) return;
		const cfg = routingConfig();
		if (!cfg) return;
		const model = resolveModel(ctx, cfg);
		if (!model) {
			warnOnce(ctx, `model:${cfg.provider}/${cfg.model}`, "Middleman has no valid model (/middleman), skipping skill routing");
			return;
		}
		const skills = loadRoutedSkills(Object.values(skillDirs()));
		if (!skills.length) return;
		const res = ctx.mode === "tui" ? await routeWithLoader(ctx, model, cfg, skills, event.prompt) : await routeSkills(ctx, model, cfg, skills, event.prompt);
		if (res.kind === "cancelled") return;
		if (res.kind === "failed") return void ctx.ui.notify(`Middleman skill routing failed, sending without skills: ${res.error}`, "warning");
		const blocks = newBlocks(ctx, res.picked);
		if (!blocks.length) return;
		return {
			message: {
				customType: SKILLS_TYPE,
				content: blocks.map((b) => b.block).join("\n\n"),
				display: true,
				details: { names: blocks.map((b) => b.name) },
			},
		};
	});
}
