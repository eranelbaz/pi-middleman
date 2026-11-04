import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig, type MiddlemanConfig, saveConfig, THINKING_LEVELS } from "../lib/config.ts";
import { clip } from "../lib/output.ts";
import { type Choice, type Outcome, type Resolution, resolveChoice, toOutcome } from "../lib/outcome.ts";
import { buildContext, reasoningFor, shouldRefine } from "../lib/refine.ts";

const CONFIG_PATH = join(getAgentDir(), "middleman.json");
const NOTE_TYPE = "middleman-note";
const TIMEOUT_MS = 60_000;

type Model = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

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

function showStatus(ctx: ExtensionContext, cfg: MiddlemanConfig | undefined) {
	if (!cfg) ctx.ui.setStatus("middleman", "mm:config error");
	else ctx.ui.setStatus("middleman", cfg.enabled ? `mm:${cfg.model ?? "?"}${cfg.approval === "auto" ? " auto" : ""}` : undefined);
}

function refreshStatus(ctx: ExtensionContext) {
	try {
		showStatus(ctx, loadConfig(CONFIG_PATH));
	} catch {
		showStatus(ctx, undefined);
	}
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
		refreshStatus(ctx);
	});

	pi.registerCommand("middleman", {
		description: "Configure the prompt middleman",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/middleman requires interactive mode", "error");
				return;
			}
			let cfg: MiddlemanConfig;
			try {
				cfg = loadConfig(CONFIG_PATH);
			} catch (e) {
				ctx.ui.notify(`Fix or delete the config first: ${(e as Error).message}`, "error");
				return;
			}
			const mark = (label: string, current: boolean) => (current ? `${label} ✓` : label);
			while (true) {
				const saved = JSON.stringify(cfg);
				const promptLine = cfg.refinePrompt.replace(/\s+/g, " ").trim();
				const items = {
					enabled: `Enabled: ${cfg.enabled ? "on" : "off"}`,
					model: `Model: ${cfg.provider && cfg.model ? `${cfg.provider}/${cfg.model}` : "(not set)"}`,
					thinking: `Thinking: ${cfg.thinking}`,
					approval: `Approval: ${cfg.approval}`,
					prompt: `Refine prompt: ${promptLine.slice(0, 50)}${promptLine.length > 50 ? "…" : ""}`,
					reset: "Reset refine prompt to default",
				};
				const pick = await ctx.ui.select("Middleman", Object.values(items));
				const key = (Object.keys(items) as (keyof typeof items)[]).find((k) => items[k] === pick);
				if (!key) break;
				if (key === "enabled") cfg.enabled = !cfg.enabled;
				if (key === "approval") cfg.approval = cfg.approval === "ask" ? "auto" : "ask";
				if (key === "reset") cfg.refinePrompt = DEFAULT_CONFIG.refinePrompt;
				if (key === "thinking") {
					const labels = THINKING_LEVELS.map((t) => mark(t, t === cfg.thinking));
					const t = await ctx.ui.select("Thinking effort", labels);
					const i = t === undefined ? -1 : labels.indexOf(t);
					if (i !== -1) cfg.thinking = THINKING_LEVELS[i];
				}
				if (key === "model") {
					const models = ctx.modelRegistry.getAvailable();
					if (!models.length) {
						ctx.ui.notify("No models with working auth — log in to a provider first", "warning");
						continue;
					}
					const labels = models.map((x) => mark(`${x.provider}/${x.id}`, x.provider === cfg.provider && x.id === cfg.model));
					const m = await ctx.ui.select("Middleman model", labels);
					const chosen = m === undefined ? undefined : models[labels.indexOf(m)];
					if (chosen) {
						cfg.provider = chosen.provider;
						cfg.model = chosen.id;
					}
				}
				if (key === "prompt") {
					const p = await ctx.ui.editor("Refine prompt", cfg.refinePrompt);
					if (p?.trim()) cfg.refinePrompt = p;
				}
				if (JSON.stringify(cfg) === saved) continue;
				if (cfg.enabled && !cfg.model) ctx.ui.notify("Pick a model or prompts will pass through unchanged", "warning");
				try {
					saveConfig(CONFIG_PATH, cfg);
				} catch (e) {
					ctx.ui.notify(`Could not save middleman config: ${(e as Error).message}`, "error");
					break;
				}
				warned.clear();
				refreshStatus(ctx);
			}
		},
	});

	pi.on("input", async (event, ctx) => {
		if (!event.streamingBehavior) pendingNote = undefined;
		let cfg: MiddlemanConfig;
		try {
			cfg = loadConfig(CONFIG_PATH);
		} catch (e) {
			showStatus(ctx, undefined);
			if (event.source !== "extension" && !event.text.startsWith("/")) {
				warnOnce(ctx, "config", `Middleman config unreadable, passing prompts through: ${(e as Error).message}`);
			}
			return { action: "continue" };
		}
		showStatus(ctx, cfg);
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
