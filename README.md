# pi-middleman

A [Pi](https://github.com/earendil-works/pi) extension that loads skills on demand. A small "middleman" model reads each prompt and picks which skills the agent needs, so only those skills reach the context instead of every skill's description in every system prompt.

## Install

```bash
pi install git:github.com/eranelbaz/pi-middleman
```

## Settings (`/middleman`)

| Setting | Values | Description |
| --- | --- | --- |
| Skill routing | on / off | Let the middleman pick skills to load per prompt |
| Model | any model with working auth | The middleman model (a fast, cheap one is best) |
| Thinking | off, minimal, low, medium, high, xhigh, max | Reasoning effort for the middleman |
| Editing | session / project / global | Which layer changes are saved to (see [Config](#config)) |
| Clear overrides | — | Remove every key from the edited layer |

Changes are saved right away and apply to the next prompt without `/reload`. With routing on, the footer shows `mm:<model>`.

## How it works

Instead of installing skills into pi (where every skill's description goes into every system prompt), put them in a middleman skills folder:

- global: `~/.pi/agent/middleman-skills/<name>/SKILL.md`
- project: `<cwd>/.pi/middleman-skills/<name>/SKILL.md` (trusted repos only, same rules as project config; wins on name clashes)

Manage them with `/middleman-skill` (not `pi install`, so they stay out of pi's system prompt):

```text
/middleman-skill install user/repo            # GitHub shorthand, optional @branch, @tag or @commit
/middleman-skill install git:gitlab.com/a/b   # any git URL (https, ssh, git@…)
/middleman-skill install ./path/to/skills     # local path (prefix ./ if it looks like user/repo)
/middleman-skill list
/middleman-skill remove <name>
```

Add `--project` to install into or remove from the project folder. Install finds every skill in the source (folders with `SKILL.md` using pi's discovery rules, or `.md` files with a `description` in their frontmatter) and copies each into its own folder named after the skill (frontmatter `name`, else the folder or file name), asking before overwriting; headless runs refuse to overwrite, so remove first. Nothing is replaced unless every skill copied successfully. Skill names must be lowercase letters, digits and single hyphens; invalid, duplicate, and symlinked skills are skipped and listed. Dotfiles (including `.env` and `.git`), `node_modules`, and symlinks are never copied, and a source inside the skills folder is refused. Git sources are cloned to a temp dir that is deleted afterwards, with credential prompts disabled and a 120 second limit; there is no update command yet, so reinstall to update. Arguments are split on spaces, so paths containing spaces are not supported.

With **Skill routing** on, each prompt you send is shown to the middleman model together with the list of skill names and descriptions. It picks up to 3 relevant skills (often none), and their full `SKILL.md` bodies are injected as a message before the agent runs, shown as a collapsed `✦ middleman loaded skills: …` line. Skills already loaded earlier in the current branch are not injected again.

Your prompt itself is never changed. Routing is skipped for prompts with images, `/skill:` invocations, steers/follow-ups typed while the agent is streaming, and prompts sent by other extensions. Pressing `Esc` while skills are being picked skips routing for that prompt. If routing fails or takes longer than 20 seconds, the prompt is sent without skills and a warning is shown. After compaction, a skill whose body was summarized away can be loaded again.

## Config

Settings come from three layers:

| Scope | Where | Lifetime |
| --- | --- | --- |
| session | memory only | Cleared on `/new`, `/resume`, `/fork`, `/reload` and restart |
| project | `<cwd>/.pi/middleman.json` | Read once per session |
| global | `~/.pi/agent/middleman.json` (or `$PI_CODING_AGENT_DIR/middleman.json`) | Read on every prompt |

Each key resolves on its own: `session → project → global → defaults`. Files hold only the keys they override. `provider` and `model` must be set together, or both are ignored in that layer.

Project files are used only in repos you have explicitly trusted in pi (pi's trust prompt or `/trust`), never in your home directory. They are read once at session start, so changes (e.g. from `git pull`) apply in the next session. Trust is pi's nearest-ancestor decision, so trusting a parent folder (e.g. `~/projects`) enables project files in every repo under it. Project files can be committed for a team or gitignored for personal use.

In `/middleman`, **Editing** picks the layer your changes go to. Each label shows which layer its value comes from. "Clear" removes keys from the layer being edited.

Example global file:

```json
{
  "skillRouting": true,
  "provider": "anthropic",
  "model": "claude-haiku-4-5",
  "thinking": "off"
}
```

If a config file can't be read or isn't a JSON object, skill routing is skipped, the footer shows `mm:config error`, and `/middleman` never overwrites it. A broken global file keeps `/middleman` closed until you fix or delete it; hand edits to it apply on the next prompt. A broken project file is shown at the top of `/middleman`; select it to re-read the file after fixing it (otherwise it is re-read in the next session).

Older `enabled`, `approval` and `refinePrompt` keys from the prompt-rewriting version are ignored; delete them whenever you like.

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
