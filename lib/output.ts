const OPEN = "<rewritten>";
const CLOSE = "</rewritten>";
const FENCE = /^[ \t]*(`{3,}(?=[^`]*$)|~{3,})/;

export function parseRewrite(raw: string): string | undefined {
	const end = raw.lastIndexOf(CLOSE);
	const start = end === -1 ? -1 : raw.lastIndexOf(OPEN, end);
	if (start === -1) return undefined;
	const before = raw.slice(0, start);
	if (before.split(OPEN).length > before.split(CLOSE).length) return undefined;
	const body = raw.slice(start + OPEN.length, end).replace(/^\s*\n/, "").replace(/\r?\n\s*$/, "");
	return body.trim() ? body : undefined;
}

export function clip(s: string, maxLines = 15, maxChars = 1500): string {
	const shown = s.slice(0, maxChars).split("\n").slice(0, maxLines).join("\n");
	return shown.length < s.length ? `${shown}\n… (truncated, ${s.length - shown.length} more chars)` : s;
}

function codeBlocks(text: string): string[] {
	const lines = text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/^(?:[ \t]*>)+ ?/, ""));
	const blocks: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const fence = lines[i].match(FENCE)?.[1];
		if (!fence) continue;
		const close = new RegExp(`^[ \\t]*${fence[0]}{${fence.length},}[ \\t\\r]*$`);
		let j = i + 1;
		while (j < lines.length && !close.test(lines[j])) j++;
		blocks.push(lines.slice(i, j + 1).join("\n"));
		i = j;
	}
	return blocks;
}

export function keepsCodeBlocks(original: string, rewritten: string): boolean {
	const kept = new Set(codeBlocks(rewritten));
	return codeBlocks(original).every((block) => kept.has(block));
}
