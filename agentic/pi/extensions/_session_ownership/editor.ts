/** Ownership-aware editor composition used by splash and voice input. */
import {
	CustomEditor,
	type AppKeybinding,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
const protectedMode = () => Boolean(process.env.PI_SESSION_OWNER);
export class OwnedEditor extends CustomEditor {
	constructor(tui: TUI, theme: EditorTheme, bindings: KeybindingsManager) {
		super(tui, theme, bindings);
		let submit: ((text: string) => void) | undefined = this.onSubmit;
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			get: () => (text: string) =>
				submit?.(
					protectedMode() && /^\/(resume|new|fork)(?:\s|$)/.test(text.trim())
						? text.trim().replace(/^\/(resume|new|fork)/, "/pi-owned-$1")
						: text,
				),
			set: (fn: typeof submit) => {
				submit = fn;
			},
		});
		const map = this.actionHandlers;
		const originalSet = map.set.bind(map);
		map.set = (action: AppKeybinding, handler: () => void) =>
			originalSet(
				action,
				(["app.session.resume", "app.session.new", "app.session.fork"] as string[]).includes(action)
					? () =>
							protectedMode() ? this.onSubmit?.(`/pi-owned-${action.split(".").at(-1)}`) : handler()
					: handler,
			);
	}
}
