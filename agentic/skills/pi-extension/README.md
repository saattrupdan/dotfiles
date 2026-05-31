# pi-extension

Reference for writing extensions for **pi** (`@earendil-works/pi-coding-agent`), the
coding agent CLI. Extensions are the *only* supported way to change pi's behaviour —
never edit the installed package or its upstream source.

- Official docs: <https://pi.dev/docs/latest/extensions>
- Installed package (read for ground truth when docs are thin): locate it via
  `npm root -g` (then `@earendil-works/pi-coding-agent`), or alongside the `pi` binary.
- Type defs (the real API contract): `<pkg>/dist/core/extensions/types.d.ts`

## How extensions are discovered and loaded

- Each extension is a **subdirectory** of pi's extensions directory containing `index.ts`.
  That directory is `$PI_CODING_AGENT_DIR/extensions` (default `~/.pi/agent/extensions/`).
- Loading is **automatic** — there is no `extensions` array in `settings.json`. Drop a
  directory in and it's live next launch.
- Directories whose name starts with `_` (e.g. `_outliner`, `_types`, `_memory`) are
  **shared libraries** imported by other extensions, not loaded as extensions themselves.
- Extensions are TypeScript and loaded directly — **no build step**. Match the existing
  style: **tabs**, `import type` for type-only imports, a top-of-file doc comment
  explaining purpose + usage.

## Minimal extension

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("message_update", (event, ctx) => {
		const type = event.assistantMessageEvent?.type;
		if (type === "thinking_start" || type === "thinking_delta") {
			ctx.ui.setWorkingMessage("Thinking...");
		}
	});
}
```

The default export is a factory receiving `pi: ExtensionAPI`. Register hooks, tools,
commands, etc. inside it. Module-scope `let`/`const` is your per-session state.

## `pi.on(event, handler)` — lifecycle events

Handler shape: `(event, ctx) => Promise<R | void> | R | void`. Many events ignore the
return; some use it to **modify** behaviour (noted below).

| Event | Notable payload / return |
| --- | --- |
| `session_start` / `session_shutdown` | session lifecycle |
| `session_before_switch` / `_fork` / `_compact` / `_tree` | return a result to influence the action |
| `session_compact` / `session_tree` | post-action notifications |
| `context` | inspect/return modified context |
| `before_provider_request` | **mutate `event.payload`** to inject provider params |
| `after_provider_response` | raw provider response |
| `before_agent_start` | inject messages / **modify `event.systemPrompt`** |
| `agent_start` | once per user prompt |
| `agent_end` | `event.messages` for the whole prompt |
| `turn_start` / `turn_end` | per LLM cycle; `turn_end` has `event.message`, `event.toolResults` |
| `message_start` | a message begins (user/assistant/custom) |
| `message_update` | streaming deltas: `event.message` + `event.assistantMessageEvent` |
| `message_end` | **return `{ message }` to replace** (persisted to session!) |
| `tool_execution_start` / `_update` / `_end` | execution lifecycle |
| `tool_call` | **return `{ block: true, reason }`** to block a call |
| `tool_result` | **return modified result**; handlers chain |
| `model_select` / `thinking_level_select` | notification of selection changes |
| `user_bash` / `input` | user-input hooks; can return results |

### Streaming delta types

`event.assistantMessageEvent.type` (from `@earendil-works/pi-ai`) is a discriminated
union — the cleanest way to know *what* is currently streaming:

```
start
text_start | text_delta | text_end
thinking_start | thinking_delta | thinking_end
toolcall_start | toolcall_delta | toolcall_end
done | error
```

## Other `pi.*` registration methods

- `pi.registerTool(def)` — a tool the LLM can call (with optional `renderCall`/`renderResult`).
- `pi.registerCommand(name, opts)` — a `/slash` command.
- `pi.registerShortcut(keyId, opts)` — a keybinding.
- `pi.registerFlag(name, opts)` / `pi.getFlag(name)` — a CLI flag.
- `pi.registerMessageRenderer(customType, renderer)` — custom TUI rendering **for your
  own custom message type only** (see limits below).
- `pi.registerProvider(name, config)` / `pi.unregisterProvider(name)` — model providers / OAuth.
- `pi.appendEntry(customType, data)`, `pi.setSessionName`, `pi.setLabel(entryId, label)`.
- `pi.setModel`, `pi.get/setThinkingLevel`, `pi.get/setActiveTools`, `pi.getAllTools`,
  `pi.getCommands`, `pi.exec(cmd, args, opts)`.

## `ctx` — ExtensionContext

- `ctx.ui` — UI methods. **No-ops in print/RPC mode**; gate on `ctx.hasUI` when it matters.
- `ctx.sessionManager` — **read-only** `ReadonlySessionManager`: `getEntries()`, `getBranch()`.
  You **cannot** mutate session entries from an extension.
- `ctx.model`, `ctx.modelRegistry`, `ctx.cwd`.
- `ctx.isIdle()`, `ctx.signal` (AbortSignal while streaming), `ctx.abort()`,
  `ctx.hasPendingMessages()`, `ctx.shutdown()`.

### `ctx.ui` surface

- Status/working: `setStatus(key, text)`, `setWorkingMessage(msg?)`,
  `setWorkingVisible(bool)`, `setWorkingIndicator(opts)`.
- Reasoning label: `setHiddenThinkingLabel(label?)` — **global, see limits**.
- Chrome: `setWidget(key, content, opts)`, `setFooter(factory)`, `setHeader(factory)`, `setTitle`.
- Dialogs: `notify(msg, type)`, `confirm(title, msg)`, `select(title, options)`,
  `input(...)`, `editor(...)`, `custom(factory, opts)` (a full TUI component).
- Editor: `pasteToEditor`, `setEditorText`, `getEditorText`, `setEditorComponent`, `addAutocompleteProvider`.
- Theme: `theme`, `getTheme`, `setTheme`, `getAllThemes`, `get/setToolsExpanded`.

## Rendering limits & gotchas

These are the walls you'll hit; design around them.

1. **Built-in message rendering is not overridable.** `registerMessageRenderer` only
   applies to messages whose type is your custom type. Assistant/user/tool messages
   render via pi's own components, which extensions cannot replace or patch.

2. **`setHiddenThinkingLabel` is global and can't zero a line.** It loops every message
   in the chat (history included) and re-renders them with the same label — so it cannot
   show different text on the active vs. finished thinking block. And pi *always* renders
   one line for a hidden thinking block: pi-tui `Text.render` returns no lines only when
   the string trims to `""`, but the label is wrapped in ANSI color/italic codes, so an
   empty label yields a **blank line**, not nothing. Net: you can change the label text,
   never remove the line. (Verify rendering empirically by importing the installed
   `Text` + `theme` and calling `.render(width)`.)

3. **`message_end` replacement persists.** Returning `{ message }` rewrites the stored
   session message — so anything you strip is gone from history and from features that
   rebuild from session (e.g. the built-in reasoning-visibility toggle). Don't strip
   content you still need.

4. **Some UI state resets on reload/session-switch.** `resetExtensionUI()` (fired on
   `/reload` and before session invalidation) restores defaults like the hidden-thinking
   label and clears extension footers/widgets/statuses. If a setting must persist,
   re-apply it on `session_start` / `agent_start`.

5. **Footer spinner is transient — use it for vanishing indicators.**
   `setWorkingMessage("…")` updates the live spinner and pi clears it automatically when
   streaming stops. Pass `undefined` to restore the default (`"Working..."`). Great for a
   "show during reasoning, disappear after" indicator that you *can't* achieve inline.

## Verifying changes

- **Transpile/syntax check** (no `tsc`/`tsx` in repo; `bun` is available):
  ```bash
  bun build index.ts --target=node --external @earendil-works/pi-coding-agent --outfile=/dev/null
  ```
  This strips types and bundles — it catches syntax errors and bad imports, but not full
  type errors. For types, read `types.d.ts` and check signatures by hand.
- **API ground truth**: `<pkg>/dist/core/extensions/types.d.ts` for events,
  `ExtensionContext`, `ExtensionUIContext`, and `ExtensionAPI` (find `<pkg>` via
  `npm root -g`, or next to the `pi` binary). When docs are thin, read the compiled
  `dist/` (e.g. `dist/modes/interactive/...`) to learn actual behaviour.
- **Runtime**: interactive/TUI behaviour can only be confirmed by running pi live with a
  model — there's no headless way to observe the footer/chat rendering.

## Worked example: reasoning indicator

An extension that gives the footer a phase-specific label — `"Thinking..."` while
reasoning streams, and `"Reading..."/"Writing..."/"Editing..."/"Bashing..."` for the
matching tools — and relabels the inline hidden-thinking marker. It demonstrates
footer-spinner control, the global-label limitation, re-applying settings after resets,
and **covering both tool phases** (arg streaming via the trailing `toolCall` content
block, plus execution via `tool_execution_*`, with execution taking precedence):

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOL_LABELS: Record<string, string> = {
	read: "Reading...", write: "Writing...", edit: "Editing...", bash: "Bashing...",
};

export default function (pi: ExtensionAPI) {
	// Replace the misleading persistent "Thinking..." with a static marker.
	// (Can't be removed entirely — pi always renders a line for a hidden block.)
	const LABEL = "(hidden thoughts)";
	pi.on("session_start", (_e, ctx) => ctx.ui.setHiddenThinkingLabel(LABEL));
	pi.on("agent_start", (_e, ctx) => ctx.ui.setHiddenThinkingLabel(LABEL));

	let streamLabel: string | undefined;          // current streaming phase
	const activeTools = new Map<string, string>(); // executing tools (id -> label)
	const current = () =>
		activeTools.size > 0 ? [...activeTools.values()].at(-1) : streamLabel;
	const apply = (ctx: { ui: { setWorkingMessage(m?: string): void } }) =>
		ctx.ui.setWorkingMessage(current()); // undefined -> pi default "Working..."

	pi.on("message_update", (event, ctx) => {
		const blocks = event.message?.content;
		const last = Array.isArray(blocks) ? blocks.at(-1) : undefined;
		const next = last?.type === "thinking" ? "Thinking..."
			: last?.type === "toolCall" ? TOOL_LABELS[last.name]
			: undefined;
		if (next === streamLabel) return;
		streamLabel = next; apply(ctx);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		const label = TOOL_LABELS[event.toolName];
		if (label) { activeTools.set(event.toolCallId, label); apply(ctx); }
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (activeTools.delete(event.toolCallId)) apply(ctx);
	});
	pi.on("message_end", (_e, ctx) => { if (streamLabel) { streamLabel = undefined; apply(ctx); } });
	pi.on("agent_end", (_e, ctx) => { streamLabel = undefined; activeTools.clear(); apply(ctx); });
}
```

**Note:** extensions load at startup — after editing one, `/reload` (which reloads
extensions, skills, prompts, themes, keybindings) or restart pi to pick up the change.

**Adding a tool?** When you register a new tool with `pi.registerTool`, also add its
`name -> "Doing..."` entry to a footer-status extension's `TOOL_LABELS` map (the names
must match the tool's registered `name`, e.g. `web_browse`, `memory_save`). Otherwise the
new tool silently shows the generic "Working..." instead of a phase-specific label.
