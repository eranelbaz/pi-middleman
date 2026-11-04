import type { AssistantMessage } from "@earendil-works/pi-ai";
import { keepsCodeBlocks, parseRewrite } from "./output.ts";
import { extractText } from "./refine.ts";

export type Outcome = { kind: "ok"; text: string } | { kind: "failed"; error: string } | { kind: "cancelled" };
export type Choice = "approve" | "original" | "reject";
export type Resolution = { action: "transform"; text: string } | { action: "continue" } | { action: "handled"; restore: string };

export function toOutcome(res: AssistantMessage, original: string, cancelled: boolean): Outcome {
	if (cancelled) return { kind: "cancelled" };
	if (res.stopReason === "error") return { kind: "failed", error: res.errorMessage ?? "request failed" };
	if (res.stopReason === "aborted") return { kind: "failed", error: "request aborted or timed out" };
	if (res.stopReason !== "stop") return { kind: "failed", error: `stopped: ${res.stopReason}` };
	const text = parseRewrite(extractText(res));
	if (!text) return { kind: "failed", error: "no <rewritten> output" };
	if (!keepsCodeBlocks(original, text)) return { kind: "failed", error: "rewrite altered a code block" };
	return { kind: "ok", text };
}

export function resolveChoice(choice: Choice | undefined, original: string, refined: string): Resolution {
	if (choice === "approve") return { action: "transform", text: refined };
	if (choice === "reject") return { action: "handled", restore: original };
	return { action: "continue" };
}
