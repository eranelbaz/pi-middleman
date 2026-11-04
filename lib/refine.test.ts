import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@jest/globals";
import { DEFAULT_CONFIG } from "./config.ts";
import { buildContext, countWords, extractText, FRAMING, reasoningFor, shouldRefine } from "./refine.ts";

const on = { ...DEFAULT_CONFIG, enabled: true, provider: "p", model: "m" };
const ev = (text: string, extra = {}) => ({ text, source: "interactive", ...extra });

describe("shouldRefine", () => {
	it("refines normal input when enabled", () => {
		expect(shouldRefine(ev("please fix the failing login test"), on)).toBe(true);
	});
	it("skips when disabled", () => {
		expect(shouldRefine(ev("please fix the failing login test"), DEFAULT_CONFIG)).toBe(false);
	});
	it("skips extension, slash, blank, and short input", () => {
		expect(shouldRefine({ text: "please fix the failing test", source: "extension" }, on)).toBe(false);
		expect(shouldRefine(ev("/skill:review the whole repo please"), on)).toBe(false);
		expect(shouldRefine(ev("   "), on)).toBe(false);
		expect(shouldRefine(ev("yes do it"), on)).toBe(false);
	});
	it("skips steer/follow-up and prompts with images", () => {
		expect(shouldRefine(ev("please fix the failing login test", { streamingBehavior: "steer" }), on)).toBe(false);
		expect(shouldRefine(ev("what is wrong in this screenshot", { images: [{}] }), on)).toBe(false);
	});
});

describe("countWords", () => {
	it("counts words in languages without spaces and ignores punctuation", () => {
		expect(countWords("请帮我修复登录测试")).toBeGreaterThanOrEqual(4);
		expect(countWords("yes, do it!")).toBe(3);
		expect(countWords("--- ... !!!")).toBe(0);
	});
});

describe("buildContext", () => {
	it("puts fixed framing before the refine prompt and wraps the raw text in tags", () => {
		const ctx = buildContext(on, "hello world");
		expect(ctx.systemPrompt).toBe(`${FRAMING}\n\n${on.refinePrompt}`);
		expect(ctx.messages).toHaveLength(1);
		expect(ctx.messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "<user_prompt>\nhello world\n</user_prompt>" }],
		});
	});
});

describe("reasoningFor", () => {
	it("maps off to undefined and passes others through", () => {
		expect(reasoningFor({ ...on, thinking: "off" })).toBeUndefined();
		expect(reasoningFor({ ...on, thinking: "high" })).toBe("high");
	});
});

describe("extractText", () => {
	it("concatenates text parts without inserting separators and ignores thinking", () => {
		const msg = {
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "<rewritten>a b" },
				{ type: "text", text: "c</rewritten>" },
			],
		} as unknown as AssistantMessage;
		expect(extractText(msg)).toBe("<rewritten>a bc</rewritten>");
	});
});
