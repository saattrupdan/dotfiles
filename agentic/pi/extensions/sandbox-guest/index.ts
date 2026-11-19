/** Guest-only inference transport and visible sandbox status. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installGuestProvider } from "../../sandbox/guest-provider.mjs";

export default async function (pi: ExtensionAPI) {
	await installGuestProvider(pi);
}
