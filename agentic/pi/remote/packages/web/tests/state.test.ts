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
  let status: string | undefined = "forwarded";
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
    status = undefined;
    store.connect(id);
    Socket.latest.onopen?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.statuses[command], "delivery_unknown");
    status = "persisted";
    store.connect(id);
    Socket.latest.onopen?.();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(store.statuses[command], "persisted");
    assert.equal(store.pending[command], undefined);
    assert.equal(submissions, 1);
    store.folder = "/private/working-folder";
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
    assert.equal(store.folder, undefined);
    assert.deepEqual(store.drafts, {});
    assert.deepEqual(store.pending, {});
    const stale = Socket.latest;
    auth.unlocked = true;
    stale.onmessage?.({
      data: JSON.stringify({
        version: 1,
        type: "snapshot",
        sessionId: id,
        data: [{ role: "user", content: "Stale private socket" }],
      }),
    });
    assert.deepEqual(store.messages, {});
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

test("home loads folders and live summaries; newer snapshots win and lock purges both", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
    location: { protocol: "https:", host: "fixture.test.ts.net" },
    WebSocket: Socket,
  });
  setActivePinia(createPinia());
  const auth = useAuth();
  const store = useSessions();
  auth.unlocked = true;
  const requests: Array<{ url: string; resolve: (value: unknown) => void }> = [];
  auth.request = ((url: string) =>
    new Promise((resolve) => requests.push({ url, resolve }))) as typeof auth.request;
  try {
    const initial = store.loadFolders();
    assert.deepEqual(
      requests.map((request) => request.url),
      ["/session-folders", "/sessions"],
    );
    const latest = store.refresh();
    requests[2]!.resolve([{ sessionId: "live", state: "running" }]);
    await latest;
    requests[1]!.resolve([{ sessionId: "stale", state: "idle" }]);
    requests[0]!.resolve([{ cwd: "/Users/fixture", count: 1, lastActivity: 1000 }]);
    await initial;
    assert.equal(store.listing[0]?.sessionId, "live");
    assert.equal(store.folders[0]?.cwd, "/Users/fixture");
    assert(!requests.some((request) => request.url.includes("/history")));
    const background = store.loadFolders();
    auth.clear();
    requests[3]!.resolve([{ cwd: "/Users/private", count: 1, lastActivity: 1000 }]);
    requests[4]!.resolve([{ sessionId: "private", state: "running" }]);
    await background;
    assert.deepEqual(store.folders, []);
    assert.deepEqual(store.listing, []);
    assert.deepEqual(store.sessions, []);
  } finally {
    auth.clear();
    mock.restoreAll();
    mock.timers.reset();
  }
});

test("read-only native sessions preserve drafts and never recover or submit commands", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
  });
  setActivePinia(createPinia());
  const auth = useAuth();
  const store = useSessions();
  auth.unlocked = true;
  const reason = "Phone control needs /reload in this session on the Mac.";
  const id = "c2d90aba-4820-494b-978d-1991e3e820cf";
  store.sessions = [
    {
      sessionId: id,
      epoch: 1,
      state: "running",
      controlBlockedReason: reason,
    } as Session,
  ];
  store.drafts[id] = "Keep this draft";
  const requests: string[] = [];
  auth.request = (async (url: string) => {
    requests.push(url);
    throw new Error("Unexpected request");
  }) as typeof auth.request;
  for (const command of [
    { action: "message", text: "Must stay unsent", images: [] },
    { action: "stop_session" },
  ] as const)
    await assert.rejects(
      store.command(id, {
        ...command,
        ...(command.action === "message" ? { images: [] } : {}),
      }),
      /needs \/reload/,
    );
  assert.deepEqual(requests, []);
  assert.equal(store.drafts[id], "Keep this draft");
  assert.deepEqual(store.pending, {});
  assert.deepEqual(store.statuses, {});
});
