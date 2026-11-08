import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ThinkingSetting = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ApprovalMode = "auto" | "ask";

export interface MiddlemanConfig {
	enabled: boolean;
	provider?: string;
	model?: string;
	thinking: ThinkingSetting;
	refinePrompt: string;
	approval: ApprovalMode;
	skillRouting: boolean;
}

export const THINKING_LEVELS: ThinkingSetting[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const APPROVAL_MODES: ApprovalMode[] = ["auto", "ask"];

export const DEFAULT_CONFIG: MiddlemanConfig = {
	enabled: false,
	thinking: "off",
	refinePrompt: "Make the prompt clearer and more concise while preserving every requirement and constraint.",
	approval: "ask",
	skillRouting: false,
};

export class ConfigError extends Error {}

export type Layer = Partial<MiddlemanConfig>;
export type Scope = "session" | "project" | "global";
export const SCOPES: Scope[] = ["session", "project", "global"];

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function readRaw(path: string): Record<string, unknown> | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw new ConfigError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${path}: not a JSON object`);
	return raw as Record<string, unknown>;
}

export function parseLayer(raw: unknown, path: string): Layer {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${path}: not a JSON object`);
	const r = raw as Record<string, unknown>;
	return {
		...(typeof r.enabled === "boolean" && { enabled: r.enabled }),
		...(nonEmpty(r.provider) && nonEmpty(r.model) && { provider: r.provider, model: r.model }),
		...(THINKING_LEVELS.includes(r.thinking as ThinkingSetting) && { thinking: r.thinking as ThinkingSetting }),
		...(nonEmpty(r.refinePrompt) && { refinePrompt: r.refinePrompt }),
		...(APPROVAL_MODES.includes(r.approval as ApprovalMode) && { approval: r.approval as ApprovalMode }),
		...(typeof r.skillRouting === "boolean" && { skillRouting: r.skillRouting }),
	};
}

export function readLayer(path: string): Layer {
	const raw = readRaw(path);
	return raw ? parseLayer(raw, path) : {};
}

export function mergeLayers(layers: Layer[]): MiddlemanConfig {
	const cfg: MiddlemanConfig = { ...DEFAULT_CONFIG };
	for (const layer of [...layers].reverse()) {
		for (const [k, v] of Object.entries(layer)) if (v !== undefined) Object.assign(cfg, { [k]: v });
	}
	return cfg;
}

export function sourceOf(key: keyof MiddlemanConfig, layers: Partial<Record<Scope, Layer>>): Scope | "default" {
	return SCOPES.find((s) => layers[s]?.[key] !== undefined) ?? "default";
}

export function loadConfig(path: string): MiddlemanConfig {
	return mergeLayers([readLayer(path)]);
}

export function patchLayer(path: string, patch: Layer): void {
	const next: Record<string, unknown> = { ...readRaw(path) };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) delete next[k];
		else next[k] = v;
	}
	if (!Object.keys(next).length) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
		renameSync(tmp, path);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
}
