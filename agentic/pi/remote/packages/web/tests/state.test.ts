import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import type { Session } from "../../../protocol/src/index.ts";
import { useAuth } from "../src/frontend/stores/auth.ts";
import { useSessions } from "../src/frontend/stores/sessions.ts";
class Socket {
  static OPEN = 1;
  static latest: Socket;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  constructor() {
    Socket.latest = this;
  }
  send() {}
  close() {}
}
test("phone reconnect reconciles without resending; background preserves drafts, revocation clears immediately", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
    location: { protocol: "https:", host: "fixture.test.ts.net" },
    WebSocket: Socket,
  });
  setActivePinia(createPinia());
  const auth = useAuth();
  const store = useSessions();
  const id = "c2d90aba-4820-494b-978d-1991e3e820cf";
  let submissions = 0;
  let status = "forwarded";
  auth.request = (async (url: string) => {
    if (url.endsWith("/actions")) {
      submissions++;
      return { status };
    }
    if (url.startsWith("/commands/")) return { status };
    if (url === "/sessions") return [{ sessionId: id, epoch: 1, sequence: 0 }];
    return { messages: [], next: null };
  }) as typeof auth.request;
  auth.unlocked = true;
  auth.visible = true;
  store.sessions = [{ sessionId: id, epoch: 1, sequence: 0 } as Session];
  try {
    const command = await store.command(id, {
      action: "message",
      text: "Private draft",
      images: [],
    });
    assert(store.pending[command]);
    store.statuses[command] = "delivery_unknown";
    status = "persisted";
    store.connect(id);
    Socket.latest.onopen?.();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(store.statuses[command], "persisted");
    assert.equal(store.pending[command], undefined);
    assert.equal(submissions, 1);
    store.drafts[id] = "Memory only";
    store.messages[id] = [{ role: "user", content: "Private transcript" }];
    auth.visible = false;
    Socket.latest.onclose?.({ code: 4000 });
    assert.equal(store.drafts[id], "Memory only");
    assert(auth.unlocked);
    auth.visible = true;
    store.connect(id);
    Socket.latest.onclose?.({ code: 4001 });
    assert(!auth.unlocked);
    assert.deepEqual(store.messages, {});
    assert.deepEqual(store.drafts, {});
    assert.deepEqual(store.pending, {});
    auth.unlocked = true;
    let release!: (value: unknown) => void;
    auth.request = (() =>
      new Promise((resolve) => {
        release = resolve;
      })) as typeof auth.request;
    const reading = store.history(id);
    auth.clear();
    release({
      messages: [{ role: "user", content: "Late private response" }],
      next: null,
    });
    await reading;
    assert.deepEqual(store.messages, {});
  } finally {
    auth.clear();
    mock.timers.reset();
  }
});
