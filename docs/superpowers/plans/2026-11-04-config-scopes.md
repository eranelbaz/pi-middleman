# Middleman Config Scopes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve middleman settings per key from three layers — session (memory) → project (`<cwd>/.pi/middleman.json`, explicitly trusted repos only) → global (`~/.pi/agent/middleman.json`) → defaults — and let `/middleman` edit any one layer.
**Architecture:** `lib/config.ts` gains pure, unit-tested layer primitives (parse, read, merge, source lookup, raw patch-write). `extensions/middleman.ts` owns the session layer, snapshots the project layer, and adds an "Editing" scope selector to the menu.
**Tech Stack:** TypeScript (ESM, `.ts` imports), Jest via `@swc/jest`, `@earendil-works/pi-coding-agent` 1.4.0, `@earendil-works/pi-tui`.
**Spec:** this document (design agreed in chat; layering mirrors pi-subagents-lite ADR-0008, trust is stricter — see below).

## Global Constraints

- Tabs, no comments, match existing style. Tests import from `@jest/globals`. `npm test` and `npm run check` pass after every task.
- Layer files hold only the keys they set; the merged config is never written anywhere.
- Writes are read-modify-write on the **raw** JSON object: unknown/invalid keys in the file are preserved, a malformed file (bad JSON / non-object) is never overwritten, `undefined` in a patch deletes that key, a file left with no keys is removed.
- `provider` + `model` are one unit: a layer counts for them only if both are non-empty strings; otherwise both are dropped from that layer.
- **Trust (stricter than pi):** pi auto-trusts repos with no trust-requiring resources (`main.js:595-600`; `middleman.json` isn't on its list), so `isProjectTrusted()` alone would let any cloned repo inject a `refinePrompt`. The project layer is used only when `ctx.isProjectTrusted() && new ProjectTrustStore(getAgentDir()).get(ctx.cwd) === true` (an explicit, saved trust decision) and `ctx.cwd` is not the home dir.
- The project layer may not set `approval` (key ignored when read; not offered in project scope) so a repo can never switch a user to unreviewed auto mode.
- The project layer is snapshotted at `session_start` and after menu writes — not re-read per prompt — so files changed mid-session (git pull, agent tools) take effect only in a new session.
- Malformed layer → that error is reported once per session (keyed by path) and prompts pass through unchanged; the menu still opens and shows the broken layer, which can't be selected for editing.
- Session layer: memory only. pi re-imports extensions on every session change (`/new`, `/resume`, `/fork`, `/reload`), so it is cleared on all of them; `session_start` also resets it explicitly.
- Do not commit `nohup.out`.

## File Structure

- `lib/config.ts` — add `Layer`, `Scope`, `SCOPES`, `parseLayer`, `readLayer`, `patchLayer`, `mergeLayers`, `sourceOf`; `loadConfig` rebuilt on them; `saveConfig` removed (only the extension used it).
- `lib/config.test.ts` — tests for the above.
- `extensions/middleman.ts` — trust check, layers, snapshot, layered resolve, menu scope.
- `README.md` — Config section.

---

### Task 1: Layer primitives in `lib/config.ts`

**Files:** Modify `lib/config.ts`, `lib/config.test.ts`

**Produces:**
- `type Layer = Partial<MiddlemanConfig>`; `type Scope = "session" | "project" | "global"`; `const SCOPES: Scope[] = ["session", "project", "global"]` (highest first)
- `parseLayer(raw: unknown, path: string): Layer`
- `readLayer(path: string): Layer` — `{}` on ENOENT/ENOTDIR
- `patchLayer(path: string, patch: Layer): void`
- `mergeLayers(layers: Layer[]): MiddlemanConfig` (highest first)
- `sourceOf(key: keyof MiddlemanConfig, layers: Partial<Record<Scope, Layer>>): Scope | "default"`
- `loadConfig(path)` kept (now also drops a lone `provider`/`model`)
- `saveConfig` removed; this task swaps the extension's single `saveConfig(CONFIG_PATH, cfg)` call to `patchLayer(CONFIG_PATH, cfg)` so `npm run check` stays green

- [ ] **Step 1: Failing tests.** Replace the test file's import with `import { ConfigError, DEFAULT_CONFIG, loadConfig, mergeLayers, parseLayer, patchLayer, readLayer, sourceOf } from "./config.ts";`. Replace the two existing tests that call `saveConfig` ("leaves no temp file…", "round-trips…") with the `patchLayer` tests below, and append:

```ts
describe("layers", () => {
	it("parseLayer keeps only valid keys that are present", () => {
		expect(parseLayer({ enabled: true, thinking: "huge", refinePrompt: " ", extra: 1 }, "p")).toEqual({ enabled: true });
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
		const cfg = mergeLayers([{ refinePrompt: "cave", thinking: undefined }, { enabled: true, refinePrompt: "proj", thinking: "low" }, { provider: "p", model: "m", approval: "auto" }]);
		expect(cfg).toEqual({ ...DEFAULT_CONFIG, enabled: true, refinePrompt: "cave", thinking: "low", provider: "p", model: "m", approval: "auto" });
	});

	it("sourceOf reports the winning scope", () => {
		const layers = { session: { thinking: "low" as const }, project: { thinking: "high" as const, enabled: true }, global: { model: "m" } };
		expect(sourceOf("thinking", layers)).toBe("session");
		expect(sourceOf("enabled", layers)).toBe("project");
		expect(sourceOf("model", layers)).toBe("global");
		expect(sourceOf("approval", layers)).toBe("default");
	});
});

describe("patchLayer", () => {
	it("creates the file with only the patched keys", () => {
		const p = join(dirname(tmp()), "sub", "middleman.json");
		patchLayer(p, { refinePrompt: "cave" });
		expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ refinePrompt: "cave" });
		expect(readFileSync(p, "utf8").endsWith("\n")).toBe(true);
	});

	it("preserves unknown and invalid keys and deletes undefined ones", () => {
		const p = tmp();
		writeFileSync(p, JSON.stringify({ $schema: "s", thinking: "hgih", enabled: true, model: "m", provider: "p" }));
		patchLayer(p, { enabled: undefined, approval: "auto" });
		expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ $schema: "s", thinking: "hgih", model: "m", provider: "p", approval: "auto" });
	});

	it("removes the file when no keys remain", () => {
		const p = tmp();
		writeFileSync(p, JSON.stringify({ enabled: true }));
		patchLayer(p, { enabled: undefined });
		expect(existsSync(p)).toBe(false);
	});

	it("never overwrites a malformed file", () => {
		const p = tmp();
		for (const body of ["{nope", "[]", "null"]) {
			writeFileSync(p, body);
			expect(() => patchLayer(p, { enabled: true })).toThrow(ConfigError);
			expect(readFileSync(p, "utf8")).toBe(body);
		}
	});

	it("leaves no temp file behind when the write fails", () => {
		const p = tmp();
		mkdirSync(p);
		expect(() => patchLayer(p, { enabled: true })).toThrow();
		expect(readdirSync(dirname(p))).toEqual(["middleman.json"]);
	});
});
```

Add `existsSync` to the `node:fs` import in the test file.

- [ ] **Step 2: Run, verify fails** — `npx jest lib/config.test.ts` → FAIL (missing exports).

- [ ] **Step 3: Implement.** In `lib/config.ts` import `existsSync` too, keep the types/constants/`DEFAULT_CONFIG`/`ConfigError`, and replace `loadConfig` and `saveConfig` with:

```ts
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
```

(`existsSync` is only needed in the test; don't import it in `config.ts` unless used.) Keep the existing "merges partial file over defaults" and "drops invalid values" `loadConfig` tests; they still pass.

- [ ] **Step 4: Verify** — in `extensions/middleman.ts` change the import `saveConfig` → `patchLayer` and the call `saveConfig(CONFIG_PATH, cfg)` → `patchLayer(CONFIG_PATH, cfg)` (nothing else). `npm test && npm run check` pass.

- [ ] **Step 5: Commit** — `git add lib/config.ts lib/config.test.ts extensions/middleman.ts && git commit -m "feat(config): partial layers with per-key merge and safe patch writes"`

---

### Task 2: Layered config in the extension

**Files:** Modify `extensions/middleman.ts`, `README.md`

**Consumes:** Task 1 exports. Also `ProjectTrustStore` from `@earendil-works/pi-coding-agent` (`new ProjectTrustStore(agentDir).get(cwd): boolean | null`), `homedir` from `node:os`, `realpathSync` from `node:fs`.

- [ ] **Step 1: Module-level helpers** (replace `CONFIG_PATH` with `GLOBAL_PATH`, same value):

```ts
type Layers = Partial<Record<Scope, Layer>>;

function projectPath(ctx: ExtensionContext): string | undefined {
	if (!ctx.isProjectTrusted() || realpathSync(ctx.cwd) === realpathSync(homedir())) return undefined;
	try {
		if (new ProjectTrustStore(getAgentDir()).get(ctx.cwd) !== true) return undefined;
	} catch {
		return undefined;
	}
	return join(ctx.cwd, ".pi", "middleman.json");
}

function readProject(path: string): Layer {
	const { approval: _, ...layer } = readLayer(path);
	return layer;
}
```

- [ ] **Step 2: State inside the default export.**

```ts
	let session: Layer = {};
	let project: { path: string; layer?: Layer; error?: string } | undefined;
	const loadProject = (ctx: ExtensionContext) => {
		const path = projectPath(ctx);
		if (!path) return void (project = undefined);
		try {
			project = { path, layer: readProject(path) };
		} catch (e) {
			project = { path, error: (e as Error).message };
		}
	};
	const resolve = () => {
		const layers: Layers = { session, ...(project?.layer && { project: project.layer }), global: readLayer(GLOBAL_PATH) };
		return { cfg: mergeLayers(SCOPES.map((s) => layers[s] ?? {})), layers, projectError: project?.error };
	};
```

  - `refreshStatus` and `showStatus` move inside the default export. `refreshStatus(ctx)` uses `resolve().cfg` and passes `layers`; `showStatus(ctx, cfg?, layers?)` appends ` [proj]` to the status when `layers.project` has any key and `cfg.enabled`.
  - `session_start`: `warned.clear(); pendingNote = undefined; session = {}; loadProject(ctx); refreshStatus(ctx);`
  - `resolve()` throws only when the global file is malformed; a broken project comes back as `projectError`. `refreshStatus` shows `mm:config error` for either.
  - `input`: replace `loadConfig(CONFIG_PATH)` with `const { cfg, layers, projectError } = resolve()` inside the existing try (the existing catch handles a broken global; warn key `config:global`). Then, if `projectError`: `showStatus(ctx, undefined)`, `warnOnce(ctx, "config:project", \`Middleman config unreadable, passing prompts through: ${projectError}\`)` under the same `source !== "extension" && !startsWith("/")` guard as today, and `return { action: "continue" }`.

- [ ] **Step 3: Menu.** Rewrite the `/middleman` handler body (keep the `!ctx.hasUI` guard):

  - `let scope: Scope = "global";`
  - Loop:
    - `const scopes = SCOPES.filter((s) => s !== "project" || (project && !project.error));` If `!scopes.includes(scope)` → `scope = "global"`.
    - `let state; try { state = resolve(); } catch (e) { notify(\`Fix or delete the config first: ${msg}\`, "error"); return; }` (only a broken global throws). If `state.projectError`, add a first item `broken: \`⚠ project config broken: ${projectError}\`` — selecting it just `continue`s.
    - `const own = state.layers[scope] ?? {}`.
    - Label helper: `const from = (k) => { const s = sourceOf(k, layers); return s === "default" ? "" : \` (${s})\`; }`.
    - Items (in order): `scope: \`Editing: ${scope}\``, `enabled: \`Enabled: ${on/off}${from("enabled")}\``, `model: \`Model: …${from("model")}\``, `thinking`, `approval` (omit when `scope === "project"`), `prompt`, `reset: \`Reset refine prompt (${scope})\`` → patch `{ refinePrompt: undefined }`, `clear: \`Clear ${scope} overrides\`` (omit when `own` has no keys) → patch every key of `own` to `undefined`.
    - Select via `ctx.ui.select("Middleman", …)` as today; `scope` item uses `pick(ctx, "Apply changes to", scopes, scope)` and narrows with `scopes.find((s) => s === choice)`.
    - Each other item builds a `patch: Layer`. Toggles flip the **target layer's** value, falling back to merged, so a shadowed layer can still be toggled both ways:
      - enabled → `{ enabled: !(own.enabled ?? cfg.enabled) }`; approval → `{ approval: (own.approval ?? cfg.approval) === "ask" ? "auto" : "ask" }`
      - When `own[key]` is set and differs from the effective value, the label shows both, e.g. `Enabled: on (session) · global: off`.
      - thinking / model / prompt → as today (`pick` / `pick` / `editor`), model patch is always `{ provider, model }`.
    - Skip the write if every patched key already equals `own[key]` (compare against the target layer, not merged — so inherited values can be pinned).
    - Write: session → `session = { ...session, ...patch }` then drop `undefined` keys; project → `patchLayer(project.path, patch); loadProject(ctx)`; global → `patchLayer(GLOBAL_PATH, patch)`. Wrap the write (and any read it does) in try/catch → `notify("Could not save middleman config: …", "error"); break`.
    - After writing: re-resolve; for each patched key, if `sourceOf(key, layers)` is a scope higher than `scope` (earlier in `SCOPES`), `notify(\`${key} is overridden by the ${s} config\`, "warning")`.
    - Keep: "Pick a model…" warning on the merged config, `warned.clear(); refreshStatus(ctx)`.

- [ ] **Step 4: README.** Replace the Config section intro with:
  - a table: session (memory only; cleared on `/new`, `/resume`, `/fork`, `/reload` and restart) / project `.pi/middleman.json` / global `~/.pi/agent/middleman.json`
  - trust is pi's nearest-ancestor decision, so trusting a parent folder (e.g. `~/projects`) enables project files in every repo under it
  - per-key resolution `session → project → global → defaults`; files hold only overridden keys; `provider`+`model` must be set together
  - project files are used only in repos you have explicitly trusted in pi (pi's trust prompt / `/trust`), never in the home dir, can't set `approval`, and are read once per session
  - `/middleman` → **Editing** picks the target layer; labels show where each value comes from; "Reset" and "Clear" remove keys from that layer
  - project files can be committed for a team or gitignored for personal use

- [ ] **Step 5: Verify.** `npm test && npm run check` pass. Headless smoke with a temp agent dir (real config untouched):

```bash
D=$(mktemp -d); P="$D/proj"; mkdir -p "$P/.pi"
cp ~/.pi/agent/models.json "$D/"; [ -f ~/.pi/agent/auth.json ] && cp ~/.pi/agent/auth.json "$D/"
echo '{"enabled":true,"provider":"unsloth-studio","model":"unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL","approval":"auto"}' > "$D/middleman.json"
echo '{"refinePrompt":"Rewrite in caveman style: drop articles and filler, keep meaning."}' > "$P/.pi/middleman.json"
```

  1. Untrusted (no trust entry): from `$P`, `PI_CODING_AGENT_DIR=$D pi -p -e /Users/eranelbaz/Projects/pi-middleman/extensions/middleman.ts "hey so um can you tell me what the capital of france is"` → rewrite is the normal (non-caveman) style.
  2. Trusted: `node -e 'import("@earendil-works/pi-coding-agent").then(m=>new m.ProjectTrustStore(process.argv[1]).set(process.argv[2],true))' "$D" "$P"` (run from the repo dir so the package resolves) and rerun → caveman-style rewrite (inspect the `middleman-note` entry in the session jsonl under `$D/sessions`).
  3. `echo '{nope' > "$P/.pi/middleman.json"` and rerun → prompt passes through unchanged with a warning naming the project path.

- [ ] **Step 6: Commit** — `git add extensions/middleman.ts README.md docs/superpowers/plans/2026-11-04-config-scopes.md && git commit -m "feat: session and project config scopes"`
