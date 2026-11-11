import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createContext, runInContext } from "node:vm";
import { parse, compileScript } from "vue/compiler-sfc";
import { transformSync } from "esbuild";

const source = fs.readFileSync(
  new URL("../src/frontend/views/Settings.vue", import.meta.url),
  "utf8",
);
const { descriptor } = parse(source);
const script = descriptor.scriptSetup!.content;
const ast = compileScript(descriptor, { id: "notification-test" }).scriptSetupAst!;
const handler = ast.find(
  (node) => node.type === "FunctionDeclaration" && node.id?.name === "notifications",
)!;
const support = ast.find(
  (node) =>
    node.type === "VariableDeclaration" &&
    node.declarations.some(
      (declaration) =>
        declaration.id.type === "Identifier" &&
        declaration.id.name === "notificationsSupported",
    ),
);

function settings(browser: Record<string, unknown> = {}, granted = true) {
  const calls: { url: string; options?: RequestInit }[] = [];
  let permissionRequests = 0;
  let subscriptions = 0;
  const value = { endpoint: "https://web.push.apple.com/fixture", keys: {} };
  const environment = {
    Notification: {
      requestPermission: async () => {
        permissionRequests++;
        return granted ? "granted" : "denied";
      },
    },
    PushManager: class {},
    navigator: {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            subscribe: async (options: PushSubscriptionOptionsInit) => {
              subscriptions++;
              assert.equal(options.userVisibleOnly, true);
              assert.deepEqual(
                Array.from(options.applicationServerKey as Uint8Array),
                [1, 2, 3],
              );
              return { toJSON: () => value };
            },
          },
        }),
      },
    },
    ...browser,
  };
  const error = { value: "previous error" };
  const note = { value: "previous success" };
  const context = createContext({
    ...environment,
    error,
    note,
    notifying: { value: false },
    atob,
    Uint8Array,
    auth: {
      async request(url: string, options?: RequestInit) {
        calls.push({ url, options });
        return url === "/push/key" ? { key: "AQID" } : {};
      },
    },
  });
  const code = [
    support ? script.slice(support.start!, support.end!) : "",
    script.slice(handler.start!, handler.end!),
    "globalThis.enable = notifications;",
  ].join("\n");
  runInContext(transformSync(code, { loader: "ts" }).code, context);
  return {
    enable: context.enable as () => Promise<void>,
    calls,
    error,
    note,
    value,
    permissions: () => permissionRequests,
    subscriptions: () => subscriptions,
  };
}

for (const [name, browser] of [
  ["Notification", { Notification: undefined }],
  ["PushManager", { PushManager: undefined }],
  ["service workers", { navigator: {} }],
  ["navigator", { navigator: undefined }],
] as const) {
  test(`notification settings explain missing ${name} without calling browser APIs`, async () => {
    const ui = settings(browser);
    await ui.enable();
    assert.match(ui.error.value, /Home Screen/);
    assert.doesNotMatch(ui.error.value, /not defined|Can't find variable/);
    assert.equal(ui.note.value, "");
    assert.equal(ui.permissions(), 0);
    assert.equal(ui.subscriptions(), 0);
    assert.deepEqual(ui.calls, []);
  });
}

test("notification settings register the subscription in a supported browser", async () => {
  const ui = settings();
  await ui.enable();
  assert.equal(ui.permissions(), 1);
  assert.equal(ui.subscriptions(), 1);
  assert.equal(ui.error.value, "");
  assert.match(ui.note.value, /notifications enabled/);
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.calls[0]?.url, "/push/key");
  assert.equal(ui.calls[0]?.options, undefined);
  assert.equal(ui.calls[1]?.url, "/push/subscriptions");
  assert.equal(ui.calls[1]?.options?.method, "POST");
  assert.equal(ui.calls[1]?.options?.body, JSON.stringify(ui.value));
});

test("notification permission denial never creates a subscription", async () => {
  const ui = settings({}, false);
  await ui.enable();
  assert.match(ui.error.value, /permission was not granted/);
  assert.equal(ui.note.value, "");
  assert.equal(ui.permissions(), 1);
  assert.equal(ui.subscriptions(), 0);
  assert.deepEqual(ui.calls, []);
});

test("unsupported notification controls are disabled with visible guidance", () => {
  assert.match(
    descriptor.template!.content,
    /:disabled="!notificationsSupported \|\| notifying"/,
  );
  assert.match(descriptor.template!.content, /Home Screen/);
});
