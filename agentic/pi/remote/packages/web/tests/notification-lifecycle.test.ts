import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { parse, compileScript } from "vue/compiler-sfc";
import { transformSync } from "esbuild";
import { activateNotifications } from "../src/frontend/lib/notifications.ts";

for (const permission of ["granted", "default", "denied"]) {
  test(`foreground clears delivered notifications and restores only ${permission} permission`, async (t) => {
    const descriptors = ["navigator", "Notification"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    );
    t.after(() => {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    });
    let closed = 0,
      created = 0;
    const requests: string[] = [];
    const subscription = {
      toJSON: () => ({
        endpoint: "https://web.push.apple.com/fixture",
        keys: { auth: "fixture", p256dh: "fixture" },
      }),
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        serviceWorker: {
          getRegistration: async () => ({
            getNotifications: async () => [
              {
                close() {
                  closed++;
                },
              },
              {
                close() {
                  closed++;
                },
              },
            ],
            pushManager: {
              getSubscription: async () => subscription,
              subscribe: async () => {
                created++;
                return subscription;
              },
            },
          }),
        },
      },
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: {
        permission,
        requestPermission() {
          throw new Error("Must not prompt on entry");
        },
      },
    });
    await activateNotifications(
      (async (path: string) => {
        requests.push(path);
        return {};
      }) as never,
      () => true,
    );
    assert.equal(closed, 2);
    assert.equal(created, 0);
    assert.deepEqual(requests, permission === "granted" ? ["/push/subscriptions"] : []);
    closed = 0;
    await activateNotifications(
      (async () => {
        throw new Error("Must not register after lock");
      }) as never,
      () => false,
    );
    assert.equal(closed, 0);
  });
}

test("worker shows session-named failed notifications and focuses the existing app", async () => {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  let shown: unknown,
    title = "",
    focused = 0,
    opened = 0,
    closed = 0,
    navigated = "";
  let pending: Promise<unknown> | undefined;
  const worker = {
    location: { origin: "https://fixture.test.ts.net" },
    addEventListener: (
      name: string,
      handler: (event: Record<string, unknown>) => void,
    ) => handlers.set(name, handler),
    registration: {
      showNotification: async (_title: string, options: unknown) => {
        title = _title;
        shown = options;
      },
      getNotifications: async () => [
        {
          close() {
            closed++;
          },
        },
      ],
    },
  };
  const client = {
    id: "phone",
    type: "window",
    url: "https://fixture.test.ts.net/",
    navigate: async () => {
      throw new Error("Must not reload an existing app and lose drafts");
    },
    postMessage(data: { url: string; id: number }) {
      navigated = data.url;
      handlers.get("message")!({
        source: client,
        data: { type: "notification-opened", id: data.id },
      });
    },
    focus: async () => {
      focused++;
    },
  };
  runInNewContext(
    fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
    {
      self: worker,
      URL,
      setTimeout: () => 1,
      clearTimeout: () => {},
      clients: {
        matchAll: async () => [client],
        openWindow: async () => {
          opened++;
        },
      },
    },
  );
  const waitUntil = (value: Promise<unknown>) => (pending = value);
  handlers.get("push")!({
    data: { json: () => ({ title: "Session fixture", body: "A run failed." }) },
    waitUntil,
  });
  await pending;
  assert.equal((shown as { body: string }).body, "A run failed.");
  assert.equal(title, "Session fixture");
  handlers.get("notificationclick")!({
    notification: {
      data: { url: "/session/c2d90aba-4820-494b-978d-1991e3e820cf" },
      close() {
        closed++;
      },
    },
    waitUntil,
  });
  await pending;
  assert.equal(focused, 1);
  assert.equal(opened, 0);
  assert.equal(closed, 2);
  assert.match(navigated, /^\/session\//);
});

test("notification links route within the app without reloading or accepting foreign URLs", async () => {
  const source = fs.readFileSync(
    new URL("../src/frontend/App.vue", import.meta.url),
    "utf8",
  );
  const { descriptor } = parse(source),
    ast = compileScript(descriptor, { id: "notification-link-test" }).scriptSetupAst!;
  const handler = ast.find(
    (node) =>
      node.type === "FunctionDeclaration" && node.id?.name === "openNotification",
  )!;
  const paths: string[] = [];
  const acknowledged: unknown[] = [];
  const currentRoute = { value: { path: "/" } };
  const context = {
    router: {
      currentRoute,
      isReady: async () => {},
      push: async (path: string) => {
        paths.push(path);
        currentRoute.value.path = path;
      },
    },
    location: { origin: "https://fixture.test.ts.net" },
    route: undefined as unknown,
  };
  runInNewContext(
    transformSync(
      descriptor.scriptSetup!.content.slice(handler.start!, handler.end!) +
        "\nglobalThis.route=openNotification;",
      { loader: "ts" },
    ).code,
    context,
  );
  const route = context.route as (event: unknown) => Promise<void>;
  const url = "/session/c2d90aba-4820-494b-978d-1991e3e820cf";
  await route({
    origin: "https://other.test",
    data: { type: "notification-open", url },
  });
  await route({
    origin: context.location.origin,
    data: { type: "notification-open", url: "https://other.test" },
  });
  await route({
    origin: context.location.origin,
    data: { type: "notification-open", url, id: 1 },
    source: { postMessage: (data: unknown) => acknowledged.push(data) },
  });
  assert.deepEqual(paths, [url]);
  assert.equal(
    JSON.stringify(acknowledged),
    JSON.stringify([{ type: "notification-opened", id: 1 }]),
  );
});

for (const existing of [true, false]) {
  test(`notification click survives ${existing ? "an existing app loading" : "a cold launch that opens Home"}`, async () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => void>();
    const url = "/session/c2d90aba-4820-494b-978d-1991e3e820cf",
      origin = "https://fixture.test.ts.net";
    let ready = false,
      settled = false,
      dropped = 0,
      focused = 0,
      opened = 0;
    const paths: string[] = [];
    const timers = new Map<number, () => void>();
    const client = {
      id: "phone",
      type: "window",
      url: origin + "/",
      focused: true,
      visibilityState: "visible",
      focus: async () => {
        focused++;
      },
      postMessage(data: { url: string; id: number }) {
        if (!ready) {
          dropped++;
          return;
        }
        paths.push(data.url);
        handlers.get("message")!({
          source: client,
          data: { type: "notification-opened", id: data.id },
        });
      },
      navigate() {
        throw new Error("Must not reload or discard drafts");
      },
    };
    const worker = {
      location: { origin },
      addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) =>
        handlers.set(type, fn),
      registration: { getNotifications: async () => [] },
    };
    runInNewContext(
      fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
      {
        self: worker,
        URL,
        setTimeout: (callback: () => void) => {
          const id = timers.size + 1;
          timers.set(id, callback);
          return id;
        },
        clearTimeout: (id: number) => timers.delete(id),
        clients: {
          matchAll: async () => (existing ? [client] : []),
          openWindow: async () => {
            opened++;
            return client;
          },
        },
      },
    );
    let pending!: Promise<unknown>;
    handlers.get("notificationclick")!({
      notification: { data: { url }, close() {} },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
        void promise.then(() => (settled = true));
      },
    });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(
      dropped,
      1,
      "early routing is dropped until the app installs its listener",
    );
    assert.equal(
      settled,
      false,
      "keep worker alive until the conversation is acknowledged",
    );
    assert.equal(focused, existing ? 1 : 0);
    assert.equal(opened, existing ? 0 : 1);
    ready = true;
    const receive = handlers.get("message")!;
    receive({
      source: { ...client, url: "https://other.test/" },
      data: { type: "notification-ready" },
    });
    assert.deepEqual(paths, []);
    receive({
      source: { ...client, id: "other-window" },
      data: { type: "notification-ready" },
    });
    assert.deepEqual(
      paths,
      [],
      "another same-origin window must not consume the click",
    );
    receive({ source: client, data: { type: "notification-ready" } });
    await pending;
    assert.deepEqual(paths, [url]);
    assert.equal(timers.size, 0);
    receive({ source: client, data: { type: "notification-ready" } });
    assert.deepEqual(
      paths,
      [url],
      "acknowledged clicks must not replay on later focus",
    );
    ready = false;
    handlers.get("notificationclick")!({
      notification: { data: { url }, close() {} },
      waitUntil: (value: Promise<unknown>) => {
        pending = value;
      },
    });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(timers.size, 1);
    [...timers.values()][0]!();
    await pending;
    ready = true;
    receive({ source: client, data: { type: "notification-ready" } });
    assert.deepEqual(
      paths,
      [url],
      "expired targets must not replay on later readiness",
    );
    assert.equal(timers.size, 0);
  });
}
