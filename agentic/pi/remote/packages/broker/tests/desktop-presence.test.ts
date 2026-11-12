import test from "node:test";
import assert from "node:assert/strict";
import { phoneNotificationsAllowed } from "../src/desktop-presence.ts";

const consoleUser = (fields = "") =>
  `  |   "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes${fields}})`;
const unlocked = consoleUser();

for (const [idle, allowed] of [
  ["0", false],
  ["1000000000", false],
  ["59999999999", false],
  ["60000000000", true],
  ["60000000001", true],
  ["18446744073709551615", true],
] as const) {
  test(`Mac idle ${idle}ns permits phone notifications: ${allowed}`, async () => {
    const calls: string[][] = [];
    const result = await phoneNotificationsAllowed(async (args) => {
      calls.push([...args]);
      return args.includes("Root") ? unlocked : `    "HIDIdleTime" = ${idle}\n`;
    }, "darwin");
    assert.equal(result, allowed);
    assert.deepEqual(calls, [
      ["-n", "Root", "-d1", "-l"],
      ["-r", "-c", "IOHIDSystem", "-d1", "-l"],
    ]);
  });
}

test("locked console permits alerts immediately, without querying input idle", async () => {
  let calls = 0;
  assert.equal(
    await phoneNotificationsAllowed(async (args) => {
      calls++;
      assert(args.includes("Root"));
      return consoleUser(',"CGSSessionScreenIsLocked"=Yes');
    }, "darwin"),
    true,
  );
  assert.equal(calls, 1);
});

test("an inactive locked console cannot mask the active Mac user", async () => {
  const users =
    '"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=No,"CGSSessionScreenIsLocked"=Yes},{"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenIsLocked"=No})';
  assert.equal(
    await phoneNotificationsAllowed(
      async (args) => (args.includes("Root") ? users : '"HIDIdleTime" = 1'),
      "darwin",
    ),
    false,
  );
});

for (const idle of [
  "",
  "-1",
  "1.5",
  "NaN",
  "0x1",
  "12 trailing",
  '"0"',
  '0\n"HIDIdleTime" = 100',
]) {
  test(`unknown or malformed idle keeps alerts available: ${JSON.stringify(idle)}`, async () => {
    assert.equal(
      await phoneNotificationsAllowed(
        async (args) => (args.includes("Root") ? unlocked : `"HIDIdleTime" = ${idle}`),
        "darwin",
      ),
      true,
    );
  });
}

for (const root of [
  "",
  '"IOConsoleUsers" = ()',
  '"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=No})',
  '"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes},{"kCGSSessionOnConsoleKey"=Yes})',
]) {
  test(`unknown console keeps alerts available: ${JSON.stringify(root)}`, async () => {
    assert.equal(await phoneNotificationsAllowed(async () => root, "darwin"), true);
  });
}

for (const failure of [
  "console timeout",
  "idle timeout",
  "output limit",
  "ioreg unavailable",
]) {
  test(`probe failure keeps alerts available: ${failure}`, async () => {
    assert.equal(
      await phoneNotificationsAllowed(async (args) => {
        if (failure === "idle timeout" && args.includes("Root")) return unlocked;
        throw new Error(failure);
      }, "darwin"),
      true,
    );
  });
}

test("unsupported hosts preserve notification delivery without probing", async () => {
  assert.equal(
    await phoneNotificationsAllowed(async () => {
      throw new Error("Must not query macOS registry on Linux");
    }, "linux"),
    true,
  );
});

test("presence is sampled afresh, never cached after Mac input", async () => {
  let idle = "60000000000";
  const read = async (args: readonly string[]) =>
    args.includes("Root") ? unlocked : `"HIDIdleTime" = ${idle}`;
  assert.equal(await phoneNotificationsAllowed(read, "darwin"), true);
  idle = "0";
  assert.equal(await phoneNotificationsAllowed(read, "darwin"), false);
});
