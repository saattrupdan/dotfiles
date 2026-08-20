import { expect, test } from "bun:test";

import { selectPiInvocation } from "./pi-invocation.ts";

const args = ["--mode", "json", "-p", "--no-session"];

test("reuses the actual Pi CLI script", () => {
	expect(
		selectPiInvocation(args, {
			execPath: "/opt/homebrew/bin/node",
			currentScript: "/opt/homebrew/bin/pi",
			resolvedScript: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
		}),
	).toEqual({ command: "/opt/homebrew/bin/node", args: ["/opt/homebrew/bin/pi", ...args] });
});

test("uses Pi from PATH when embedded in Pi Web", () => {
	expect(
		selectPiInvocation(args, {
			execPath: "/opt/homebrew/bin/node",
			currentScript: "/usr/local/lib/node_modules/@agegr/pi-web/bin/pi-web.js",
			resolvedScript: "/usr/local/lib/node_modules/@agegr/pi-web/bin/pi-web.js",
		}),
	).toEqual({ command: "pi", args });
});

test("uses Pi from PATH for a Bun virtual host script", () => {
	expect(
		selectPiInvocation(args, {
			execPath: "/usr/local/bin/bun",
			currentScript: "/$bunfs/root/pi-web.js",
		}),
	).toEqual({ command: "pi", args });
});

test("reuses a packaged Pi executable", () => {
	expect(
		selectPiInvocation(args, {
			execPath: "/Applications/Pi.app/Contents/MacOS/pi",
			currentScript: "/Applications/Pi.app/Contents/Resources/app.js",
			resolvedScript: "/Applications/Pi.app/Contents/Resources/app.js",
		}),
	).toEqual({ command: "/Applications/Pi.app/Contents/MacOS/pi", args });
});

test("uses Pi from PATH when a generic runtime has no host script", () => {
	expect(selectPiInvocation(args, { execPath: "/usr/bin/node" })).toEqual({ command: "pi", args });
});
