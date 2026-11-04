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
| Model | any model with working auth | The middleman model |
| Thinking | off, minimal, low, medium, high, xhigh, max | Reasoning effort for the middleman |
| Approval | ask / auto | Review each rewrite, or send it right away |
| Refine prompt | free text | Instructions given to the middleman |
| Reset refine prompt | — | Restore the default refine prompt |

Changes are saved right away and apply to the next prompt without `/reload`. When enabled, the footer shows `mm:<model>` (plus `auto` in auto mode).

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

In auto mode, and always in headless runs (`pi -p`, RPC), the rewrite is sent without review. Whenever a rewrite is sent (auto or approved), a collapsed `⇄` note is recorded below your message; expand it to see before and after. The note is display-only and is not sent to the model.

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

Settings are stored in `~/.pi/agent/middleman.json` (or `$PI_CODING_AGENT_DIR/middleman.json` when that's set):

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

If the file can't be read or isn't a JSON object, prompts pass through, the footer shows `mm:config error`, and `/middleman` refuses to overwrite it until you fix or delete it. Hand edits are picked up on the next prompt.

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
