# pi-middleman

A [Pi](https://github.com/earendil-works/pi) extension that rewrites every prompt with a configurable "middleman" model before it reaches your agent, with an optional before/after review.

## What it does

When you submit a prompt, pi-middleman sends it to a separate model together with your refine prompt (for example "make this clearer" or "rewrite in caveman style"). The rewritten prompt is shown for review, or sent straight away in auto mode.

## Install

```bash
pi install git:github.com/eranelbaz/pi-middleman
```

## Settings (`/middleman`)

| Setting | Values | Description |
| --- | --- | --- |
| Enabled | on / off | Turn rewriting on or off |
| Skill routing | on / off | Let the middleman pick skills to load per prompt (see [Skill routing](#skill-routing)) |
| Model | any model with working auth | The middleman model |
| Thinking | off, minimal, low, medium, high, xhigh, max | Reasoning effort for the middleman |
| Approval | ask / auto | Review each rewrite, or send it right away |
| Refine prompt | free text | Instructions given to the middleman |
| Editing | session / project / global | Which layer changes are saved to (see [Config](#config)) |
| Reset refine prompt | — | Remove the refine prompt from the edited layer |
| Clear overrides | — | Remove every key from the edited layer |

Changes are saved right away and apply to the next prompt without `/reload`. When enabled, the footer shows `mm:<model>` (plus `auto` in auto mode).

## Skill routing

Instead of installing skills into pi (where every skill's description goes into every system prompt), put them in a middleman skills folder:

- global: `~/.pi/agent/middleman-skills/<name>/SKILL.md`
- project: `<cwd>/.pi/middleman-skills/<name>/SKILL.md` (trusted repos only, same rules as project config; wins on name clashes)

Manage them with `/middleman-skill` (not `pi install`, so they stay out of pi's system prompt):

```text
/middleman-skill install user/repo            # GitHub shorthand, optional @ref
/middleman-skill install git:gitlab.com/a/b   # any git URL (https, ssh, git@…)
/middleman-skill install ./path/to/skills     # local folder or single .md file
/middleman-skill list
/middleman-skill remove <name>
```

Add `--project` to install into or remove from the project folder. Install finds every skill in the source (folders with `SKILL.md`, using pi's discovery rules) and copies each into its own folder named after the skill, asking before overwriting. Git sources are shallow-cloned to a temp dir and discarded afterwards; there is no update command yet, so reinstall to update.

With **Skill routing** on, each prompt you send is shown to the middleman model together with the list of skill names and descriptions. It picks up to 3 relevant skills (often none), and their full `SKILL.md` bodies are injected as a message before the agent runs, shown as a collapsed `✦ middleman loaded skills: …` line. Skills already loaded earlier in the current branch are not injected again.

Routing works independently of rewriting (it uses the same model and thinking setting) and runs on the final prompt, after any rewrite. It is skipped for prompts with images, `/skill:` invocations, steers/follow-ups typed while the agent is streaming, and prompts sent by other extensions. Pressing `Esc` while skills are being picked skips routing for that prompt. If routing fails or takes longer than 20 seconds, the prompt is sent without skills and a warning is shown. After compaction, a skill whose body was summarized away can be loaded again.

With routing on, the footer shows `+skills` (or `skills-only` when rewriting is off).

## Review keys

| Key | Action |
| --- | --- |
| `a` / `Enter` | Approve: send the rewritten prompt |
| `e` | Edit the rewrite in an editor, then return to the review |
| `u` | Send your original prompt |
| `f` | Toggle full text (long prompts are clipped by default) |
| `r` / `Esc` / `Ctrl+C` | Reject: send nothing and put the original back in the editor |

Pressing `Esc` (or `Ctrl+C`) while the middleman is working cancels the rewrite and puts your original back in the editor.

## Auto mode and headless behavior

If the middleman returns your prompt unchanged, it is sent immediately with no review and no note, even in ask mode. In auto mode, and always in headless runs (`pi -p`, RPC), the rewrite is sent without review. Whenever a rewrite is sent (auto or approved), a collapsed `⇄` note is recorded below your message; expand it to see before and after. The note is display-only and is not sent to the model.

## Skip rules

A prompt goes through unchanged when it:

- starts with `/` (commands, including prompts that start with an absolute path)
- is a steer or follow-up typed while the agent is streaming
- has images attached
- has fewer than 4 words (counted per language, so Chinese, Japanese, and Thai work too)
- comes from an extension rather than from you

## Safety guards

The original prompt is sent (with a warning) when:

- the middleman output is missing the expected tags
- the response stopped for any reason other than a normal finish
- the rewrite altered a fenced code block (``` or ~~~, including inside lists, blockquotes, and unclosed blocks)
- the middleman takes longer than 60 seconds

Rewrites you edit yourself with `e` are sent as written, without these checks.

The code-block check is strict: re-indenting a block or changing its closing fence counts as altering it. Indented (4-space) code without a fence and `<pre>` HTML are not checked.

If the middleman model is missing, prompts pass through unchanged. If its provider has no working auth, the request fails and the original is sent. Config and model warnings are shown once per session, not on every prompt.

## Known limits

- The middleman only sees the raw prompt, not the conversation.
- Reject restores pasted text expanded, not as `[paste #N]`.
- Other extensions' `input` handlers may transform the text before or after the middleman.
- A rewrite that contains a literal opening `<rewritten>` tag is treated as malformed and the original is sent. A literal closing `</rewritten>` inside the rewrite is kept.
- If the chosen thinking level isn't supported by the middleman model, most providers fall back to the nearest supported level; if a provider rejects it, the original prompt is sent.

## Config

Settings come from three layers:

| Scope | Where | Lifetime |
| --- | --- | --- |
| session | memory only | Cleared on `/new`, `/resume`, `/fork`, `/reload` and restart |
| project | `<cwd>/.pi/middleman.json` | Read once per session |
| global | `~/.pi/agent/middleman.json` (or `$PI_CODING_AGENT_DIR/middleman.json`) | Read on every prompt |

Each key resolves on its own: `session → project → global → defaults`. Files hold only the keys they override. `provider` and `model` must be set together, or both are ignored in that layer.

Project files are used only in repos you have explicitly trusted in pi (pi's trust prompt or `/trust`), never in your home directory. They can't set `approval`, and are read once at session start, so changes (e.g. from `git pull`) apply in the next session. Trust is pi's nearest-ancestor decision, so trusting a parent folder (e.g. `~/projects`) enables project files in every repo under it. Project files can be committed for a team or gitignored for personal use.

In `/middleman`, **Editing** picks the layer your changes go to. Each label shows which layer its value comes from. "Reset" and "Clear" remove keys from the layer being edited.

Example global file:

```json
{
  "enabled": true,
  "provider": "anthropic",
  "model": "claude-haiku-4-5",
  "thinking": "off",
  "approval": "ask",
  "refinePrompt": "Make the prompt clearer and more concise while preserving every requirement and constraint."
}
```

If a config file can't be read or isn't a JSON object, prompts pass through, the footer shows `mm:config error`, and `/middleman` never overwrites it. A broken global file keeps `/middleman` closed until you fix or delete it; hand edits to it apply on the next prompt. A broken project file is shown at the top of `/middleman`; select it to re-read the file after fixing it (otherwise it is re-read in the next session).

### Example: caveman refine prompt

```text
Rewrite in caveman style. Short words. No filler. Keep every requirement, file name, and code block exactly.
```

## Development

```bash
npm install
npm run check
npm test
pi -e ./extensions/middleman.ts
```

Don't run `pi -e` while the package is installed, or the extension will load twice.

## License

MIT
