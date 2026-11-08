import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "@jest/globals";
import { ConfigError, DEFAULT_CONFIG, loadConfig, mergeLayers, parseLayer, patchLayer, readLayer, sourceOf } from "./config.ts";

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

	it("merges partial file over defaults", () => {
		const p = tmp();
		writeFileSync(p, JSON.stringify({ skillRouting: true, thinking: "low" }));
		expect(loadConfig(p)).toEqual({ ...DEFAULT_CONFIG, skillRouting: true, thinking: "low" });
	});

	it("drops invalid values", () => {
		const p = tmp();
		writeFileSync(p, JSON.stringify({ thinking: "huge", skillRouting: "yes", provider: "   ", model: "m" }));
		expect(loadConfig(p)).toEqual(DEFAULT_CONFIG);
	});

});

describe("layers", () => {
	it("parseLayer keeps only valid keys that are present", () => {
		expect(parseLayer({ skillRouting: true, thinking: "huge", refinePrompt: "x", enabled: true, extra: 1 }, "p")).toEqual({ skillRouting: true });
		expect(parseLayer({}, "p")).toEqual({});
	});

	it("parseLayer keeps provider and model only as a non-empty pair", () => {
		expect(parseLayer({ provider: "a", model: "m" }, "p")).toEqual({ provider: "a", model: "m" });
		expect(parseLayer({ model: "m" }, "p")).toEqual({});
		expect(parseLayer({ provider: "", model: "m" }, "p")).toEqual({});
		expect(parseLayer({ provider: "a", model: 3 }, "p")).toEqual({});
	});

	it("parseLayer rejects non-objects", () => {
		for (const raw of [null, 42, "x", []]) expect(() => parseLayer(raw, "p")).toThrow(ConfigError);
	});

	it("readLayer is empty when missing or under a non-directory, throws on bad JSON", () => {
		const p = tmp();
		expect(readLayer(p)).toEqual({});
		writeFileSync(p, "{}");
		expect(readLayer(join(p, "x.json"))).toEqual({});
		writeFileSync(p, "{nope");
		expect(() => readLayer(p)).toThrow(ConfigError);
	});

	it("mergeLayers resolves per key, first layer wins, ignores undefined", () => {
		const cfg = mergeLayers([{ skillRouting: false, thinking: undefined }, { skillRouting: true, thinking: "low" }, { provider: "p", model: "m" }]);
		expect(cfg).toEqual({ ...DEFAULT_CONFIG, skillRouting: false, thinking: "low", provider: "p", model: "m" });
	});

	it("sourceOf reports the winning scope", () => {
		const layers = { session: { thinking: "low" as const }, project: { thinking: "high" as const, skillRouting: true }, global: { model: "m" } };
		expect(sourceOf("thinking", layers)).toBe("session");
		expect(sourceOf("skillRouting", layers)).toBe("project");
		expect(sourceOf("model", layers)).toBe("global");
		expect(sourceOf("provider", layers)).toBe("default");
	});
});

describe("patchLayer", () => {
	it("creates the file with only the patched keys", () => {
		const p = join(dirname(tmp()), "sub", "middleman.json");
		patchLayer(p, { thinking: "low" });
		expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ thinking: "low" });
		expect(readFileSync(p, "utf8").endsWith("\n")).toBe(true);
	});

	it("preserves unknown and invalid keys and deletes undefined ones", () => {
		const p = tmp();
		writeFileSync(p, JSON.stringify({ $schema: "s", thinking: "hgih", skillRouting: true, model: "m", provider: "p" }));
		patchLayer(p, { skillRouting: undefined, thinking: "low" });
		expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ $schema: "s", thinking: "low", model: "m", provider: "p" });
	});

	it("removes the file when no keys remain", () => {
		const p = tmp();
		writeFileSync(p, JSON.stringify({ skillRouting: true }));
		patchLayer(p, { skillRouting: undefined });
		expect(existsSync(p)).toBe(false);
	});

	it("never overwrites a malformed file", () => {
		const p = tmp();
		for (const body of ["{nope", "[]", "null"]) {
			writeFileSync(p, body);
			expect(() => patchLayer(p, { skillRouting: true })).toThrow(ConfigError);
			expect(readFileSync(p, "utf8")).toBe(body);
		}
	});

	it("leaves no temp file behind when the write fails", () => {
		const p = tmp();
		mkdirSync(p);
		expect(() => patchLayer(p, { skillRouting: true })).toThrow();
		expect(readdirSync(dirname(p))).toEqual(["middleman.json"]);
	});
});
