import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "@jest/globals";
import { ConfigError, DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "mm-")), "middleman.json");

describe("config", () => {
	it("returns defaults when file is missing", () => {
		expect(loadConfig(tmp())).toEqual(DEFAULT_CONFIG);
	});

	it("throws ConfigError on invalid JSON", () => {
		const p = tmp();
		writeFileSync(p, "{nope");
		expect(() => loadConfig(p)).toThrow(ConfigError);
	});

	it("throws ConfigError for non-object JSON so it is never overwritten", () => {
		const p = tmp();
		for (const body of ["null", "42", '"x"', "[]"]) {
			writeFileSync(p, body);
			expect(() => loadConfig(p)).toThrow(ConfigError);
		}
	});

	it("leaves no temp file behind when the write fails", () => {
		const p = tmp();
		mkdirSync(p);
		expect(() => saveConfig(p, DEFAULT_CONFIG)).toThrow();
		expect(readdirSync(dirname(p))).toEqual(["middleman.json"]);
	});

	it("merges partial file over defaults", () => {
		const p = tmp();
		writeFileSync(p, JSON.stringify({ enabled: true, approval: "auto" }));
		expect(loadConfig(p)).toEqual({ ...DEFAULT_CONFIG, enabled: true, approval: "auto" });
	});

	it("drops invalid values", () => {
		const p = tmp();
		writeFileSync(p, JSON.stringify({ thinking: "huge", approval: "maybe", refinePrompt: "   " }));
		expect(loadConfig(p)).toEqual(DEFAULT_CONFIG);
	});

	it("round-trips through save atomically", () => {
		const p = tmp();
		const cfg = { ...DEFAULT_CONFIG, enabled: true, provider: "anthropic", model: "claude-haiku-4-5" };
		saveConfig(p, cfg);
		expect(loadConfig(p)).toEqual(cfg);
		expect(readFileSync(p, "utf8").endsWith("\n")).toBe(true);
		expect(readdirSync(dirname(p))).toEqual(["middleman.json"]);
	});
});
