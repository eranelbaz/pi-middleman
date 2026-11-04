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
}

export const THINKING_LEVELS: ThinkingSetting[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const APPROVAL_MODES: ApprovalMode[] = ["auto", "ask"];

export const DEFAULT_CONFIG: MiddlemanConfig = {
	enabled: false,
	thinking: "off",
	refinePrompt: "Make the prompt clearer and more concise while preserving every requirement and constraint.",
	approval: "ask",
};

export class ConfigError extends Error {}

export function loadConfig(path: string): MiddlemanConfig {
	let raw: Partial<MiddlemanConfig>;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
		throw new ConfigError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${path}: not a JSON object`);
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
		...(typeof raw.provider === "string" && { provider: raw.provider }),
		...(typeof raw.model === "string" && { model: raw.model }),
		thinking: THINKING_LEVELS.includes(raw.thinking!) ? raw.thinking! : DEFAULT_CONFIG.thinking,
		refinePrompt: typeof raw.refinePrompt === "string" && raw.refinePrompt.trim() ? raw.refinePrompt : DEFAULT_CONFIG.refinePrompt,
		approval: APPROVAL_MODES.includes(raw.approval!) ? raw.approval! : DEFAULT_CONFIG.approval,
	};
}

export function saveConfig(path: string, cfg: MiddlemanConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
		renameSync(tmp, path);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
}
