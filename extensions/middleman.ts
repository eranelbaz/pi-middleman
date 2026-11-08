import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	getAgentDir,
	getSelectListTheme,
	loadSkillsFromDir,
	ProjectTrustStore,
	type Skill,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
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
import { clip } from "../lib/output.ts";
import { type Choice, type Outcome, type Resolution, resolveChoice, toOutcome } from "../lib/outcome.ts";
import { buildContext, extractText, reasoningFor, shouldRefine } from "../lib/refine.ts";
import { buildRouteContext, parsePicks, parseSource } from "../lib/skills.ts";

const GLOBAL_PATH = join(getAgentDir(), "middleman.json");
const GLOBAL_SKILLS = join(getAgentDir(), "middleman-skills");
const NOTE_TYPE = "middleman-note";
const SKILLS_TYPE = "middleman-skills";
const TIMEOUT_MS = 60_000;
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

function readProject(path: string): Layer {
	const { approval: _, ...layer } = readLayer(path);
	return layer;
}

function resolveModel(ctx: ExtensionContext, cfg: MiddlemanConfig): Model | undefined {
	return cfg.provider && cfg.model ? ctx.modelRegistry.find(cfg.provider, cfg.model) : undefined;
}

async function callMiddleman(ctx: ExtensionContext, model: Model, cfg: MiddlemanConfig, text: string, cancel?: AbortSignal): Promise<Outcome> {
	const signal = cancel ? AbortSignal.any([cancel, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
	try {
		const res = await ctx.modelRegistry
			.streamSimple(model, buildContext(cfg, text), { signal, maxRetries: 1, reasoning: reasoningFor(cfg) })
			.result();
		return toOutcome(res, text, cancel?.aborted ?? false);
	} catch (e) {
		if (cancel?.aborted) return { kind: "cancelled" };
		return { kind: "failed", error: e instanceof Error ? e.message : String(e) };
	}
}

function refineWithLoader(ctx: ExtensionContext, model: Model, cfg: MiddlemanConfig, text: string): Promise<Outcome> {
	return ctx.ui.custom<Outcome>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Middleman refining with ${cfg.provider}/${cfg.model}...`);
		loader.onAbort = () => done({ kind: "cancelled" });
		callMiddleman(ctx, model, cfg, text, loader.signal).then(done);
		return loader;
	});
}

type Route = { kind: "ok"; picked: Skill[] } | { kind: "failed"; error: string } | { kind: "cancelled" };

async function routeSkills(ctx: ExtensionContext, model: Model, cfg: MiddlemanConfig, skills: Skill[], prompt: string, cancel?: AbortSignal): Promise<Route> {
	const timeout = AbortSignal.timeout(ROUTE_TIMEOUT_MS);
	const signal = cancel ? AbortSignal.any([cancel, timeout]) : timeout;
	try {
		const res = await ctx.modelRegistry
			.streamSimple(model, buildRouteContext(skills, prompt), { signal, maxRetries: 0, reasoning: reasoningFor(cfg) })
			.result();
		if (cancel?.aborted) return { kind: "cancelled" };
		if (timeout.aborted) return { kind: "failed", error: `timed out after ${ROUTE_TIMEOUT_MS / 1000}s` };
		if (res.stopReason !== "stop") return { kind: "failed", error: res.errorMessage ?? `stopped: ${res.stopReason}` };
		const picked = parsePicks(extractText(res), skills);
		return picked ? { kind: "ok", picked } : { kind: "failed", error: "no <picked> output" };
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

function review(ctx: ExtensionContext, original: string, refined: string): Promise<Choice | "edit"> {
	return ctx.ui.custom<Choice | "edit">((tui, theme, kb, done) => {
		let full = false;
		const show = (s: string) => (full ? s : clip(s));
		const before = new Text(theme.fg("dim", show(original)), 1, 0);
		const after = new Text(show(refined), 1, 0);
		const root = new Container();
		root.addChild(new Text(theme.bold(theme.fg("accent", "Middleman: review prompt")), 1, 0));
		root.addChild(
			new Text(theme.fg("dim", "[a/enter] approve   [e] edit   [u] send user prompt   [f] full text   [r/esc] reject"), 1, 0),
		);
		root.addChild(new Spacer(1));
		root.addChild(new Text(theme.fg("muted", "Before"), 1, 0));
		root.addChild(before);
		root.addChild(new Spacer(1));
		root.addChild(new Text(theme.fg("muted", "After"), 1, 0));
		root.addChild(after);
		return Object.assign(root, {
			handleInput(data: string) {
				if (matchesKey(data, "a") || kb.matches(data, "tui.select.confirm")) done("approve");
				else if (matchesKey(data, "e")) done("edit");
				else if (matchesKey(data, "u")) done("original");
				else if (matchesKey(data, "r") || kb.matches(data, "tui.select.cancel")) done("reject");
				else if (matchesKey(data, "f")) {
					full = !full;
					before.setText(theme.fg("dim", show(original)));
					after.setText(show(refined));
					tui.requestRender();
				}
			},
		});
	});
}

async function reviewLoop(ctx: ExtensionContext, original: string, refined: string): Promise<{ choice: Choice; text: string }> {
	let text = refined;
	while (true) {
		const choice = await review(ctx, original, text);
		if (choice !== "edit") return { choice, text };
		const edited = await ctx.ui.editor("Edit rewritten prompt", text);
		if (edited?.trim()) text = edited;
	}
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

async function installSkills(pi: ExtensionAPI, ctx: ExtensionContext, source: string, target: string): Promise<string[]> {
	const src = parseSource(source);
	let root: string;
	let tmp: string | undefined;
	if (src.kind === "path") {
		root = resolvePath(ctx.cwd, src.path.replace(/^~(?=$|\/)/, homedir()));
		if (!existsSync(root)) throw new Error(`${root} does not exist`);
	} else {
		tmp = mkdtempSync(join(tmpdir(), "middleman-skill-"));
		root = join(tmp, "repo");
		const res = await pi.exec("git", ["clone", "--depth", "1", ...(src.ref ? ["--branch", src.ref] : []), src.url, root], { timeout: 120_000 });
		if (res.code !== 0) {
			rmSync(tmp, { recursive: true, force: true });
			throw new Error(`git clone failed: ${(res.stderr || res.stdout).trim()}`);
		}
	}
	try {
		const { skills, diagnostics } = root.endsWith(".md")
			? loadSkillsFromDir({ dir: dirname(root), source: "middleman" })
			: loadSkillsFromDir({ dir: root, source: "middleman" });
		const found = root.endsWith(".md") ? skills.filter((s) => s.filePath === root) : skills;
		if (!found.length) throw new Error(`no skills found${diagnostics.length ? `: ${diagnostics.map((d) => d.message).join("; ")}` : ""}`);
		const clashes = found.filter((s) => existsSync(join(target, s.name))).map((s) => s.name);
		if (clashes.length && !(await ctx.ui.confirm("Overwrite skills?", `Already installed: ${clashes.join(", ")}`))) {
			throw new Error("cancelled, nothing installed");
		}
		mkdirSync(target, { recursive: true });
		for (const skill of found) {
			const dest = join(target, skill.name);
			rmSync(dest, { recursive: true, force: true });
			if (basename(skill.filePath) === "SKILL.md") {
				cpSync(skill.baseDir, dest, { recursive: true, filter: (p) => basename(p) !== ".git" });
			} else {
				mkdirSync(dest);
				cpSync(skill.filePath, join(dest, "SKILL.md"));
			}
		}
		return found.map((s) => s.name);
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
	pi.registerEntryRenderer<{ before: string; after: string }>(NOTE_TYPE, (entry, { expanded }, theme) => {
		if (!entry.data) return undefined;
		const { before, after } = entry.data;
		const body = expanded
			? `${theme.fg("muted", "Before:")}\n${before}\n\n${theme.fg("muted", "After:")}\n${after}`
			: theme.fg("dim", `middleman rewrote prompt (${before.length} → ${after.length} chars) — expand to view`);
		return new Text(`${theme.fg("accent", "⇄ ")}${body}`, 1, 0);
	});

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
			project = { path, layer: readProject(path) };
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
		ctx.ui.setStatus("middleman", cfg.enabled || cfg.skillRouting
				? `mm:${cfg.model ?? "?"}${cfg.enabled ? "" : " skills-only"}${cfg.enabled && cfg.approval === "auto" ? " auto" : ""}${cfg.enabled && cfg.skillRouting ? " +skills" : ""}${proj}`
				: undefined);
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

	let pendingNote: { before: string; after: string } | undefined;
	const flushNote = () => {
		if (!pendingNote) return;
		pi.appendEntry(NOTE_TYPE, pendingNote);
		pendingNote = undefined;
	};
	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") flushNote();
	});
	pi.on("agent_end", async () => flushNote());

	pi.on("session_start", async (_event, ctx) => {
		warned.clear();
		pendingNote = undefined;
		session = {};
		loadProject(ctx);
		refreshStatus(ctx);
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
				if (basename(arg) !== arg || !existsSync(join(dest, "SKILL.md"))) return ctx.ui.notify(`No skill "${arg}" in ${target}`, "error");
				rmSync(dest, { recursive: true, force: true });
				return ctx.ui.notify(`Removed middleman skill ${arg}`, "info");
			}
			if (sub === "install" && arg && target) {
				try {
					const names = await installSkills(pi, ctx, arg, target);
					let routing = " (turn on Skill routing in /middleman to use them)";
					try {
						if (resolve().cfg.skillRouting) routing = "";
					} catch {}
					ctx.ui.notify(`Installed ${names.join(", ")} to ${target}${routing}`, "info");
				} catch (e) {
					ctx.ui.notify(`Skill install failed: ${(e as Error).message}`, "error");
				}
				return;
			}
			ctx.ui.notify("Usage: /middleman-skill install <git-url|user/repo|path> [--project] | list | remove <name> [--project]", "error");
		},
	});

	pi.registerCommand("middleman", {
		description: "Configure the prompt middleman",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/middleman requires interactive mode", "error");
				return;
			}
			const show = {
				enabled: (c: Layer) => (c.enabled ? "on" : "off"),
				skillRouting: (c: Layer) => (c.skillRouting ? "on" : "off"),
				model: (c: Layer) => (c.provider && c.model ? `${c.provider}/${c.model}` : "(not set)"),
				thinking: (c: Layer) => `${c.thinking}`,
				approval: (c: Layer) => `${c.approval}`,
				refinePrompt: (c: Layer) => {
					const line = (c.refinePrompt ?? "").replace(/\s+/g, " ").trim();
					return `${line.slice(0, 50)}${line.length > 50 ? "…" : ""}`;
				},
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
					enabled: label("Enabled", "enabled"),
					skillRouting: label("Skill routing", "skillRouting"),
					model: label("Model", "model"),
					thinking: label("Thinking", "thinking"),
					...(scope !== "project" && { approval: label("Approval", "approval") }),
					prompt: label("Refine prompt", "refinePrompt"),
					...(own.refinePrompt !== undefined && { reset: `Reset refine prompt (${scope})` }),
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
				if (key === "enabled") patch = { enabled: !(own.enabled ?? cfg.enabled) };
				if (key === "skillRouting") patch = { skillRouting: !(own.skillRouting ?? cfg.skillRouting) };
				if (key === "approval") patch = { approval: (own.approval ?? cfg.approval) === "ask" ? "auto" : "ask" };
				if (key === "reset") patch = { refinePrompt: undefined };
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
				if (key === "prompt") {
					const p = await ctx.ui.editor("Refine prompt", own.refinePrompt ?? cfg.refinePrompt);
					if (p?.trim()) patch = { refinePrompt: p };
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
				if ((after.cfg.enabled || after.cfg.skillRouting) && !after.cfg.model) ctx.ui.notify("Pick a model or prompts will pass through unchanged", "warning");
				for (const k of warned) if (k.startsWith("model:")) warned.delete(k);
				refreshStatus(ctx);
			}
		},
	});

	let routeNext = false;
	pi.on("input", async (event, ctx) => {
		if (!event.streamingBehavior) pendingNote = undefined;
		routeNext = !event.streamingBehavior && event.source !== "extension";
		const userPrompt = event.source !== "extension" && !event.text.startsWith("/");
		let state: ReturnType<typeof resolve>;
		try {
			state = resolve();
		} catch (e) {
			showStatus(ctx, undefined);
			if (userPrompt) warnOnce(ctx, "config:global", `Middleman config unreadable, passing prompts through: ${(e as Error).message}`);
			return { action: "continue" };
		}
		const { cfg, layers, projectError } = state;
		if (projectError) {
			showStatus(ctx, undefined);
			if (userPrompt) warnOnce(ctx, "config:project", `Middleman config unreadable, passing prompts through: ${projectError}`);
			return { action: "continue" };
		}
		showStatus(ctx, cfg, layers);
		if (!shouldRefine(event, cfg)) return { action: "continue" };

		const model = resolveModel(ctx, cfg);
		if (!model) {
			warnOnce(ctx, `model:${cfg.provider}/${cfg.model}`, "Middleman has no valid model (/middleman), sending prompts unchanged");
			return { action: "continue" };
		}

		const tui = ctx.mode === "tui";
		try {
			const outcome = tui ? await refineWithLoader(ctx, model, cfg, event.text) : await callMiddleman(ctx, model, cfg, event.text);
			if (outcome.kind === "cancelled") {
				ctx.ui.setEditorText(event.text);
				return { action: "handled" };
			}
			if (outcome.kind === "failed") {
				const hint = ctx.modelRegistry.hasConfiguredAuth(model) ? "" : ` (no working auth for ${cfg.provider}?)`;
				ctx.ui.notify(`Middleman failed, sending original: ${outcome.error}${hint}`, "warning");
				return { action: "continue" };
			}

			if (outcome.text === event.text) return { action: "continue" };

			let res: Resolution = { action: "transform", text: outcome.text };
			if (cfg.approval === "ask" && tui) {
				const { choice, text } = await reviewLoop(ctx, event.text, outcome.text);
				res = resolveChoice(choice, event.text, text);
			}
			if (res.action === "handled") {
				ctx.ui.setEditorText(res.restore);
				return { action: "handled" };
			}
			if (res.action === "transform") pendingNote = { before: event.text, after: res.text };
			return res;
		} catch (e) {
			ctx.ui.notify(`Middleman error, sending original: ${(e as Error).message}`, "error");
			return { action: "continue" };
		}
	});
	pi.on("before_agent_start", async (event, ctx) => {
		const fromUser = routeNext;
		routeNext = false;
		if (!fromUser || event.messageType !== "user" || event.images?.length || event.prompt.startsWith("<skill ")) return;
		let cfg: MiddlemanConfig;
		try {
			const state = resolve();
			if (state.projectError) return;
			cfg = state.cfg;
		} catch {
			return;
		}
		if (!cfg.skillRouting) return;
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
		const loaded = new Set(
			ctx.sessionManager
				.buildContextEntries()
				.flatMap((e) => (e.type === "custom_message" && e.customType === SKILLS_TYPE ? ((e.details as { names?: string[] })?.names ?? []) : [])),
		);
		const blocks = res.picked.filter((s) => !loaded.has(s.name)).flatMap((s) => {
			try {
				return [{ name: s.name, block: skillBlock(s) }];
			} catch (e) {
				ctx.ui.notify(`Middleman could not read skill ${s.name}: ${(e as Error).message}`, "warning");
				return [];
			}
		});
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
