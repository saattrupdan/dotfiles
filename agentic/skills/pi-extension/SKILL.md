---
name: pi-extension
description: Conventions and hard-won gotchas for writing pi (pi-coding-agent) extensions. Use when creating, editing, or debugging a pi extension, or when asked to change pi's behaviour — pi is changed by extending it, never by editing the installed package.
tagline: Writing pi-coding-agent extensions — anatomy, events, ctx API, rendering limits
last-updated: 2026-06-03
autoload:
  tools:
    - read
    - write
    - edit
  paths:
    - agentic/pi/extensions/**/*.ts
    - agentic/pi/extensions/package.json
    - agentic/pi/extensions/package-lock.json
    - agentic/pi/extensions/tsconfig.json
    - agentic/pi/extensions/**/package.json
    - agentic/pi/extensions/**/tsconfig.json
    - agentic/pi/agents/*.md
    - agentic/pi/prompts/*.md
---

## pi extension conventions

**Golden rule:** change pi's behaviour by writing an **extension** — never edit the
installed `@earendil-works/pi-coding-agent` package or its upstream source.
Docs: <https://pi.dev/docs/latest/extensions>

### Anatomy

- One extension = a subdirectory of pi's **extensions directory** containing `index.ts`.
  That directory is `$PI_CODING_AGENT_DIR/extensions` (default `~/.pi/agent/extensions/`).
  Extensions are **auto-discovered** — no registration in `settings.json`.
- Shared-lib dirs (conventionally `_`-prefixed, e.g. `_outliner`, `_types`) hold code reused
  across extensions. **Discovery keys on the presence of `index.ts`, NOT the `_` prefix** — pi
  loads any `<dir>/index.ts` as an extension factory and throws "does not export a valid factory
  function" if it isn't one. So a shared lib's entry file must be named anything **but** `index.ts`
  (convention here: `_outliner/outliner.ts`, `_question_protocol/protocol.ts`, `_lid_state/lid.ts`);
  import it by that explicit filename.
- TypeScript, loaded directly (no build step). Match the repo's style — typically tabs for
  indentation, `import type` for type-only imports, and a top-of-file doc comment.
- Common lint (typescript-eslint recommended): unused handler args must be `_`-prefixed; avoid `any`.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", (_event, ctx) => ctx.ui.setStatus("hi", "ready"));
}
```

### Registering behaviour (`pi.*`)

- `pi.on(event, (event, ctx) => …)` — lifecycle hooks (see README for the full list).
- `pi.registerTool(def)`, `pi.registerCommand(name, opts)`, `pi.registerShortcut`,
  `pi.registerFlag`/`getFlag`, `pi.registerMessageRenderer(customType, renderer)`,
  `pi.registerProvider`, `pi.setModel`, `pi.get/setThinkingLevel`, `pi.set/getActiveTools`.
- **When you add a tool, give it a footer label too.** If a working-status extension
  maps tool names to footer-spinner labels (see the worked example — `TOOL_LABELS`),
  registering a new tool with `pi.registerTool` should be paired with adding its
  `name -> "Doing..."` entry there, or it silently falls back to "Working...".

### The `ctx` (ExtensionContext)

- `ctx.ui` — interactive-mode UI; **no-ops in print/RPC mode** (gate on `ctx.hasUI`).
- `ctx.sessionManager` — **READ-ONLY** (`getEntries()`, `getBranch()`). You cannot mutate session.
- `ctx.model`, `ctx.modelRegistry`, `ctx.cwd`, `ctx.isIdle()`, `ctx.signal`, `ctx.abort()`.

### Key gotchas (learned the hard way)

- **You cannot override how built-in messages render.** `registerMessageRenderer`
  only handles messages with your *custom* type — not assistant/user/tool messages.
- **`ctx.ui.setHiddenThinkingLabel(label)` is GLOBAL** — it re-renders every message
  (history included), so it can't target one block. And a hidden thinking block
  **always renders ≥1 line**: an empty label gives a *blank line*, not zero lines
  (pi-tui `Text` only collapses when the string trims empty, but theme color/italic
  wrap it in ANSI). You can change the label text, not remove the line.
- **`message_end` returning `{ message }` PERSISTS** the replacement to the session.
  Don't strip content you still need (e.g. thinking traces the built-in reasoning
  toggle rebuilds from session).
- **Detect what's streaming** in `message_update` via either the delta type
  (`event.assistantMessageEvent.type`: `thinking_*|text_*|toolcall_*|done|error`) or,
  more usefully, the **last block of `event.message.content`** (`thinking` | `text` |
  `toolCall` — the `toolCall` block carries `.name`, so you can tell *which* tool).
- **A tool's elapsed time has two phases** — label both or it barely shows:
  *argument streaming* (the model generates the call; for `write`/`edit` this is the
  whole file body — seen in `message_update` as a trailing `toolCall` block) and
  *execution* (`tool_execution_start`→`tool_execution_end`; dominates for `bash`/`read`).
- **Footer spinner is transient** — `ctx.ui.setWorkingMessage("…")` auto-clears when
  streaming stops; good for live indicators that should vanish on their own. Pass
  `undefined` to restore the default ("Working...").
- Some `ctx.ui` settings are reset on `/reload` and session switch — re-apply them on
  `session_start`/`agent_start` if they must persist.

### Verifying

- If `tsc`/`tsx` aren't available, syntax/transpile-check with bun:
  `bun build index.ts --target=node --external @earendil-works/pi-coding-agent --outfile=/dev/null`
- **Source of truth for the API** is the installed type defs at
  `<pkg>/dist/core/extensions/types.d.ts` (locate `<pkg>` via `npm root -g`/`@earendil-works/pi-coding-agent`,
  or next to the `pi` binary). When docs are thin, read the compiled `dist/` for real behaviour.
- Interactive/TUI behaviour must be confirmed live (needs the TUI + a running model).
- **Always smoke-test the loaded extension by running `pi -p "<prompt>"`** (print/headless
  mode) before considering a change done. This actually loads every extension — so it catches
  load-time failures (bad factory export, broken imports, the `index.ts` gotcha above) that a
  transpile check misses — and lets you exercise the behaviour against a real prompt. A clean
  run with no "Failed to load extension …" errors confirms discovery succeeded.

See `README.md` for the full event list, `ctx.ui` surface, and worked examples.
