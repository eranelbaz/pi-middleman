import { describe, expect, it } from "@jest/globals";
import { clip, keepsCodeBlocks, parseRewrite } from "./output.ts";

describe("clip", () => {
	it("returns short text unchanged", () => {
		expect(clip("a\nb", 15, 1500)).toBe("a\nb");
	});
	it("truncates by lines and by chars and reports what was cut", () => {
		expect(clip("1\n2\n3\n4", 2, 1500)).toBe("1\n2\n… (truncated, 4 more chars)");
		expect(clip("abcdef", 15, 4)).toBe("abcd\n… (truncated, 2 more chars)");
	});
});

describe("parseRewrite", () => {
	it("extracts tagged content and ignores preamble", () => {
		expect(parseRewrite("Here is the rewritten prompt:\n<rewritten>\nfix bug\n</rewritten>")).toBe("fix bug");
	});
	it("keeps indentation of the first line", () => {
		expect(parseRewrite("<rewritten>\n    indented code\nnext\n</rewritten>")).toBe("    indented code\nnext");
	});
	it("returns undefined when tags are missing (answer or question instead of rewrite)", () => {
		expect(parseRewrite("Could you clarify which bug?")).toBeUndefined();
		expect(parseRewrite("```\nfix bug\n```")).toBeUndefined();
	});
	it("returns undefined for empty or unterminated tags", () => {
		expect(parseRewrite("<rewritten>  \n </rewritten>")).toBeUndefined();
		expect(parseRewrite("<rewritten>cut off mid")).toBeUndefined();
	});
	it("uses the last block if the model echoes the tag name earlier", () => {
		expect(parseRewrite("I will use <rewritten>x</rewritten> tags.\n<rewritten>real</rewritten>")).toBe("real");
	});
	it("rejects output where an unclosed opening tag makes the start ambiguous", () => {
		expect(parseRewrite("I'll answer in <rewritten> tags:\n<rewritten>real</rewritten>")).toBeUndefined();
		expect(parseRewrite("<rewritten>Use the <rewritten> tag here</rewritten>")).toBeUndefined();
	});
	it("keeps a literal closing tag inside the rewrite", () => {
		expect(parseRewrite("<rewritten>explain the </rewritten> tag usage here</rewritten>")).toBe("explain the </rewritten> tag usage here");
	});
	it("ignores a stray opening tag after the block", () => {
		expect(parseRewrite("<rewritten>real</rewritten> (I used the <rewritten> tag)")).toBe("real");
	});
	it("strips CRLF blank edges", () => {
		expect(parseRewrite("<rewritten>\r\nfix\r\n</rewritten>")).toBe("fix");
	});
});

describe("keepsCodeBlocks", () => {
	const block = "```ts\nconst a = 1;\n```";
	it("passes when there are no code blocks", () => {
		expect(keepsCodeBlocks("fix the bug please", "fix bug")).toBe(true);
	});
	it("passes when every block is preserved", () => {
		expect(keepsCodeBlocks(`look at\n${block}\nthanks`, `check:\n${block}`)).toBe(true);
	});
	it("ignores inline triple backticks and handles longer fences", () => {
		expect(keepsCodeBlocks(`use \`\`\`x\`\`\` then\n${block}`, `do:\n${block}`)).toBe(true);
		const outer = "````md\n```js\nx\n```\n````";
		expect(keepsCodeBlocks(`see\n${outer}`, `check\n${outer}`)).toBe(true);
	});
	it("fails when a block was changed or dropped", () => {
		expect(keepsCodeBlocks(`look at\n${block}`, "check:\n```ts\nconst a=1\n```")).toBe(false);
		expect(keepsCodeBlocks(`look at\n${block}`, "check the const")).toBe(false);
	});
	it("guards tilde, indented, empty, and longer-closing fences", () => {
		expect(keepsCodeBlocks("x\n~~~\na\n~~~", "nothing")).toBe(false);
		expect(keepsCodeBlocks("- item\n  ```\n  a\n  ```", "nothing")).toBe(false);
		expect(keepsCodeBlocks("x\n```\n```", "nothing")).toBe(false);
		expect(keepsCodeBlocks("x\n```\na\n````", "nothing")).toBe(false);
		expect(keepsCodeBlocks("x\n~~~\na\n~~~", "y\n~~~\na\n~~~")).toBe(true);
	});
	it("closes a fence regardless of its indentation without swallowing later prose", () => {
		const orig = "- item\n  ```\n  a\n```\nsome prose\n  ```\n  b\n  ```";
		expect(keepsCodeBlocks(orig, "- item\n  ```\n  a\n```\nreworded\n  ```\n  b\n  ```")).toBe(true);
		expect(keepsCodeBlocks(orig, "- item\n  ```\n  a\n```\nreworded")).toBe(false);
	});
	it("treats an unclosed fence as running to the end", () => {
		expect(keepsCodeBlocks("paste:\n```\nlet a = 1", "paste:\n```\nlet a = 2")).toBe(false);
		expect(keepsCodeBlocks("paste:\n```\nlet a = 1", "see below\n```\nlet a = 1")).toBe(true);
	});
	it("rejects text appended to an unclosed block or glued to a fence", () => {
		expect(keepsCodeBlocks("x\n```\nlet a = 1", "x\n```\nlet a = 10")).toBe(false);
		expect(keepsCodeBlocks("```\na\n```", "pre```\na\n```post")).toBe(false);
	});
	it("does not treat a line with an inline closing fence as an opener", () => {
		const block = "```ts\nconst a = 1;\n```";
		expect(keepsCodeBlocks(`\`\`\`js\`\`\`\ntext\n${block}`, `reworded\n${block}`)).toBe(true);
	});
	it("guards code blocks inside blockquotes", () => {
		expect(keepsCodeBlocks("> ```\n> a=1\n> ```", "> ```\n> a=2\n> ```")).toBe(false);
		expect(keepsCodeBlocks("> ```\n> a=1\n> ```", "see:\n> ```\n> a=1\n> ```")).toBe(true);
	});
	it("ignores line-ending differences", () => {
		expect(keepsCodeBlocks("x\r\n```\r\na\r\n```\r\n", "y\n```\na\n```")).toBe(true);
		expect(keepsCodeBlocks("x\r```\ra\r```", "nothing")).toBe(false);
	});
	it("does not close a backtick fence with tildes or a shorter fence", () => {
		expect(keepsCodeBlocks("x\n````\na\n```\nb\n````", "x\n````\na\n```\nchanged\n````")).toBe(false);
		expect(keepsCodeBlocks("x\n```\na\n~~~\nb\n```", "x\n```\na\n~~~\nchanged\n```")).toBe(false);
	});
});
