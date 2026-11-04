import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getAgentDir, getSelectListTheme, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
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
import { buildContext, reasoningFor, shouldRefine } from "../lib/refine.ts";

const GLOBAL_PATH = join(getAgentDir(), "middleman.json");
const NOTE_TYPE = "middleman-note";
const TIMEOUT_MS = 60_000;

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
		ctx.ui.setStatus("middleman", cfg.enabled ? `mm:${cfg.model ?? "?"}${cfg.approval === "auto" ? " auto" : ""}${proj}` : undefined);
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

	pi.registerCommand("middleman", {
		description: "Configure the prompt middleman",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/middleman requires interactive mode", "error");
				return;
			}
			const show = {
				enabled: (c: Layer) => (c.enabled ? "on" : "off"),
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
				if (after.cfg.enabled && !after.cfg.model) ctx.ui.notify("Pick a model or prompts will pass through unchanged", "warning");
				for (const k of warned) if (k.startsWith("model:")) warned.delete(k);
				refreshStatus(ctx);
			}
		},
	});

	pi.on("input", async (event, ctx) => {
		if (!event.streamingBehavior) pendingNote = undefined;
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
}
