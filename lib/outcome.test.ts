import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@jest/globals";
import { resolveChoice, toOutcome } from "./outcome.ts";

const msg = (text: string, stopReason = "stop", errorMessage?: string) =>
	({ content: [{ type: "text", text }], stopReason, errorMessage }) as unknown as AssistantMessage;

describe("toOutcome", () => {
	it("accepts a tagged rewrite that stopped normally", () => {
		expect(toOutcome(msg("<rewritten>fix bug</rewritten>"), "please fix the bug", false)).toEqual({ kind: "ok", text: "fix bug" });
	});
	it("treats a user cancel as cancelled regardless of stopReason", () => {
		expect(toOutcome(msg("", "error", "setup aborted"), "x", true)).toEqual({ kind: "cancelled" });
		expect(toOutcome(msg("", "aborted"), "x", true)).toEqual({ kind: "cancelled" });
	});
	it("treats any non-stop reason as failure, including aborted without a user cancel (timeout)", () => {
		expect(toOutcome(msg("", "error", "boom"), "x", false)).toEqual({ kind: "failed", error: "boom" });
		expect(toOutcome(msg("", "aborted"), "x", false)).toEqual({ kind: "failed", error: "request aborted or timed out" });
		expect(toOutcome(msg("<rewritten>half", "length"), "x", false)).toEqual({ kind: "failed", error: "stopped: length" });
	});
	it("fails when tags are missing", () => {
		expect(toOutcome(msg("Sure! 2+2 is 4."), "what is 2+2 exactly", false)).toEqual({ kind: "failed", error: "no <rewritten> output" });
	});
	it("fails when a code block was altered", () => {
		const orig = "fix this\n```js\nlet a=1\n```";
		expect(toOutcome(msg("<rewritten>fix it</rewritten>"), orig, false)).toEqual({ kind: "failed", error: "rewrite altered a code block" });
	});
});

describe("resolveChoice", () => {
	it("approve sends the rewrite", () => {
		expect(resolveChoice("approve", "orig", "new")).toEqual({ action: "transform", text: "new" });
	});
	it("original sends the user prompt untouched", () => {
		expect(resolveChoice("original", "orig", "new")).toEqual({ action: "continue" });
	});
	it("reject sends nothing and restores the original", () => {
		expect(resolveChoice("reject", "orig", "new")).toEqual({ action: "handled", restore: "orig" });
	});
	it("an unknown choice falls back to sending the original, never drops it", () => {
		expect(resolveChoice(undefined, "orig", "new")).toEqual({ action: "continue" });
	});
});
