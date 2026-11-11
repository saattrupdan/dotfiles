import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runInNewContext } from "node:vm";
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

test("worker shows generic failed notifications and focuses the existing app", async () => {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  let shown: unknown,
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
  runInNewContext(
    fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
    {
      self: worker,
      URL,
      clients: {
        matchAll: async () => [
          {
            url: "https://fixture.test.ts.net/",
            navigate: async (url: string) => {
              navigated = url;
            },
            focus: async () => {
              focused++;
            },
          },
        ],
        openWindow: async () => {
          opened++;
        },
      },
    },
  );
  const waitUntil = (value: Promise<unknown>) => (pending = value);
  handlers.get("push")!({
    data: { json: () => ({ body: "A run failed." }) },
    waitUntil,
  });
  await pending;
  assert.equal((shown as { body: string }).body, "A run failed.");
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
