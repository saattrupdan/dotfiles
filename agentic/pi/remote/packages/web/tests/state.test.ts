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
    assert.equal(store.homeLoaded, true);
    assert.equal(store.homeListing[0]?.sessionId, "live");
    const selectedFolder = store.refresh("/Users/fixture");
    requests[3]!.resolve([{ sessionId: "archive", state: "stopped" }]);
    await selectedFolder;
    assert.equal(store.listing[0]?.sessionId, "archive");
    assert.equal(store.homeListing[0]?.sessionId, "live");
    assert(!requests.some((request) => request.url.includes("/history")));
    const background = store.loadFolders();
    assert.equal(store.homeLoaded, true);
    assert.equal(store.homeListing[0]?.sessionId, "live");
    auth.clear();
    requests[4]!.resolve([{ cwd: "/Users/private", count: 1, lastActivity: 1000 }]);
    requests[5]!.resolve([{ sessionId: "private", state: "running" }]);
    await background;
    assert.deepEqual(store.folders, []);
    assert.equal(store.homeLoaded, false);
    assert.deepEqual(store.homeListing, []);
    assert.deepEqual(store.listing, []);
    assert.deepEqual(store.sessions, []);
  } finally {
    auth.clear();
    mock.restoreAll();
    mock.timers.reset();
  }
});

test("Home waits for the newest socket refresh before claiming a loaded empty listing", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
    location: { protocol: "https:", host: "fixture" },
    WebSocket: Socket,
  });
  setActivePinia(createPinia());
  const auth = useAuth(),
    store = useSessions();
  auth.unlocked = true;
  auth.visible = true;
  const requests: { url: string; resolve: (value: unknown) => void }[] = [];
  auth.request = ((url: string) =>
    new Promise((resolve) => requests.push({ url, resolve }))) as typeof auth.request;
  try {
    const initial = store.loadFolders();
    store.connect("");
    Socket.latest.onopen?.();
    assert.deepEqual(
      requests.map((request) => request.url),
      ["/session-folders", "/sessions", "/sessions"],
    );
    requests[1]!.resolve([]);
    requests[0]!.resolve([]);
    await initial;
    assert.equal(
      store.homeLoaded,
      false,
      "discarded initial response cannot declare latest Home loaded",
    );
    assert.equal(
      store.homeLoading,
      true,
      "socket refresh must keep Home loading after browse returns",
    );
    requests[2]!.resolve([{ sessionId: "live", state: "running" }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.homeLoaded, true);
    assert.equal(store.homeLoading, false);
    assert.equal(store.homeListing[0]?.sessionId, "live");
    const old = store.refresh();
    assert.equal(store.homeLoading, true);
    auth.clear();
    assert.equal(store.homeLoading, false);
    assert.equal(store.homeError, "");
    auth.unlocked = true;
    const fresh = store.loadFolders();
    requests[3]!.resolve([]);
    await old;
    assert.equal(
      store.homeLoading,
      true,
      "late pre-lock work cannot settle the new load",
    );
    requests[4]!.resolve([]);
    requests[5]!.resolve([]);
    await fresh;
    assert.equal(store.homeLoading, false);
    assert.equal(store.homeLoaded, true);
  } finally {
    auth.clear();
    t.mock.timers.reset();
  }
});

test("background Home invalidation owns loading and errors without a mounted browse", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
    location: { protocol: "https:", host: "fixture" },
    WebSocket: Socket,
  });
  setActivePinia(createPinia());
  const auth = useAuth(),
    store = useSessions();
  auth.unlocked = true;
  auth.visible = true;
  auth.request = (async () => []) as typeof auth.request;
  try {
    await store.loadFolders();
    store.connect("");
    Socket.latest.onopen?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.homeLoaded, true);
    assert.equal(store.homeLoading, false);
    let fail!: (error: Error) => void;
    auth.request = ((url: string) =>
      url === "/session-folders"
        ? Promise.resolve([])
        : new Promise((_resolve, reject) => (fail = reject))) as typeof auth.request;
    Socket.latest.onmessage?.({
      data: JSON.stringify({ version: 1, type: "sessions.changed" }),
    });
    assert.equal(store.homeLoading, true);
    fail(new Error("listing unavailable"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.homeLoading, false);
    assert.equal(store.homeError, "listing unavailable");
  } finally {
    auth.clear();
    t.mock.timers.reset();
  }
});

test("initial live connection keeps a completed empty HTTP snapshot loading until socket sync", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
    location: { protocol: "https:", host: "fixture" },
    WebSocket: Socket,
  });
  setActivePinia(createPinia());
  const auth = useAuth(),
    store = useSessions();
  auth.unlocked = true;
  auth.visible = true;
  auth.request = (async () => []) as typeof auth.request;
  try {
    store.connect("");
    await store.loadFolders();
    assert.equal(
      store.homeLoading,
      true,
      "HTTP completion cannot settle a connecting live catalog",
    );
    let release!: (rows: unknown) => void;
    auth.request = (() =>
      new Promise((resolve) => (release = resolve))) as typeof auth.request;
    Socket.latest.onopen?.();
    assert.equal(store.homeLoading, true);
    release([{ sessionId: "live", state: "running" }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.homeLoading, false);
    assert.equal(store.homeListing[0]?.sessionId, "live");
    store.disconnect();
    store.connect("");
    Socket.latest.onclose?.({ code: 1006 });
    assert.equal(store.homeLoading, false);
    assert.match(store.homeError, /Could not connect to live sessions/);
  } finally {
    auth.clear();
    t.mock.timers.reset();
  }
});

for (const foldersFirst of [true, false]) {
  test(`superseded root failure cannot discard independent folders (${foldersFirst ? "folders first" : "folders last"})`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    Object.assign(globalThis, {
      document: { visibilityState: "visible", addEventListener() {} },
      window: { addEventListener() {} },
      location: { protocol: "https:", host: "fixture" },
      WebSocket: Socket,
    });
    setActivePinia(createPinia());
    const auth = useAuth(),
      store = useSessions();
    auth.unlocked = true;
    auth.visible = true;
    const requests: {
      url: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }[] = [];
    auth.request = ((url: string) =>
      new Promise((resolve, reject) =>
        requests.push({ url, resolve, reject }),
      )) as typeof auth.request;
    try {
      const initial = store.loadFolders();
      const failed = assert.rejects(initial, /superseded request failed/);
      const latest = store.refresh();
      const folders = [{ cwd: "/Users/fixture", count: 1, lastActivity: 1000 }];
      if (foldersFirst) requests[0]!.resolve(folders);
      requests[2]!.resolve([{ sessionId: "live", state: "running" }]);
      await latest;
      requests[1]!.reject(new Error("superseded request failed"));
      await failed;
      if (!foldersFirst) {
        assert.equal(
          store.homeLoading,
          true,
          "independent folder request remains loading after paired root failure",
        );
        requests[0]!.resolve(folders);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(store.folders[0]?.cwd, "/Users/fixture");
      assert.equal(store.homeListing[0]?.sessionId, "live");
      assert.equal(store.homeLoaded, true);
      assert.equal(store.homeLoading, false);
      assert.equal(store.homeError, "");
    } finally {
      auth.clear();
      t.mock.timers.reset();
    }
  });
}

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

test("a failed command response with confirmed persistence remains successful", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
  });
  setActivePinia(createPinia());
  const auth = useAuth();
  const store = useSessions();
  auth.unlocked = true;
  const id = "c2d90aba-4820-494b-978d-1991e3e820cf";
  let submissions = 0;
  store.sessions = [{ sessionId: id, epoch: 1, state: "idle" } as Session];
  auth.request = (async (url: string) => {
    if (url.endsWith("/actions")) {
      submissions++;
      throw new Error("Connection timed out");
    }
    if (url.startsWith("/commands/")) return { status: "persisted" };
    throw new Error("Unexpected request");
  }) as typeof auth.request;
  const commandId = await store.command(id, {
    action: "message",
    text: "Send only once",
    images: [],
  });
  assert.equal(submissions, 1);
  assert.equal(store.statuses[commandId], "persisted");
  assert.equal(store.pending[commandId], undefined);
});

test("history fetches one latest window, single-flights older pages and fences late paging after lock", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
    location: { protocol: "https:", host: "fixture" },
    WebSocket: Socket,
  });
  setActivePinia(createPinia());
  const auth = useAuth();
  const store = useSessions();
  auth.unlocked = true;
  let submitted = () => {};
  const requests: { url: string; resolve: (value: unknown) => void }[] = [];
  auth.request = ((url: string) =>
    new Promise((resolve) => {
      requests.push({ url, resolve });
      submitted();
    })) as typeof auth.request;
  const latest = store.history("session");
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /window=latest/);
  const fresh = {
    role: "user",
    content: "Latest",
    timestamp: 2,
    remoteHistoryKey: "b".repeat(64),
  };
  requests[0]!.resolve({ messages: [fresh], revision: "revision", older: "cursor" });
  await latest;
  const older = store.loadOlder("session");
  const duplicate = store.loadOlder("session");
  assert.equal(requests.length, 2);
  store.messages.session!.push({ role: "assistant", content: "Live", timestamp: 3 });
  requests[1]!.resolve({
    messages: [
      {
        role: "user",
        content: "Older",
        timestamp: 1,
        remoteHistoryKey: "a".repeat(64),
      },
    ],
    revision: "revision",
    older: "earlier",
  });
  await older;
  await duplicate;
  assert.deepEqual(
    store.messages.session!.map((row) => row.content),
    ["Older", "Latest", "Live"],
  );
  const posted = new Promise<void>((resolve) => (submitted = resolve));
  const refresh = store.history("session");
  await posted;
  assert.match(requests[2]!.url, /anchor=a{64}/);
  requests[2]!.resolve({
    messages: [
      fresh,
      {
        role: "assistant",
        content: "Live",
        timestamp: 3,
        remoteHistoryKey: "c".repeat(64),
      },
    ],
    revision: "new",
    older: "duplicate-cursor",
    anchorFound: true,
    anchoredOlder: "correct-earlier",
  });
  await refresh;
  assert.deepEqual(
    store.messages.session!.map((row) => row.content),
    ["Older", "Latest", "Live"],
  );
  assert.equal(store.historyPages.session!.older, "correct-earlier");
  const pending = store.loadOlder("session");
  auth.clear();
  requests[3]!.resolve({
    messages: [{ role: "user", content: "Private late page" }],
    revision: "new",
    older: null,
  });
  await pending;
  assert.deepEqual(store.messages, {});
  assert.deepEqual(store.historyPages, {});
});

test("live arrivals are retained when an older latest-history response finishes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
  });
  setActivePinia(createPinia());
  const auth = useAuth();
  auth.unlocked = true;
  const store = useSessions();
  let finish!: (value: unknown) => void;
  auth.request = (() =>
    new Promise((resolve) => (finish = resolve))) as typeof auth.request;
  const loading = store.history("session");
  store.messages.session = [
    { role: "assistant", content: "New live message", timestamp: 2 },
  ];
  finish({
    messages: [{ role: "user", content: "Older saved message", timestamp: 1 }],
    revision: "r",
    older: null,
  });
  await loading;
  assert.deepEqual(
    store.messages.session!.map((row) => row.content),
    ["Older saved message", "New live message"],
  );
});

test("older paging waits for an in-flight provenance refresh instead of prepending an obsolete snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
  });
  setActivePinia(createPinia());
  const auth = useAuth();
  auth.unlocked = true;
  const store = useSessions();
  const message = {
    role: "user",
    content: "Current",
    timestamp: 1,
    remoteHistoryKey: "a".repeat(64),
  };
  store.messages.session = [message];
  store.historyPages.session = {
    revision: "old",
    older: "old-cursor",
    loading: false,
    error: "",
  };
  let finish!: (value: unknown) => void;
  let posted!: () => void;
  const ready = new Promise<void>((resolve) => (posted = resolve));
  const calls: string[] = [];
  auth.request = ((url: string) => {
    calls.push(url);
    if (url.includes("window=latest")) {
      posted();
      return new Promise((resolve) => (finish = resolve));
    }
    return Promise.resolve({
      messages: [
        {
          role: "user",
          content: url.includes("new-cursor") ? "Canonical older" : "Obsolete older",
          remoteHistoryKey: "b".repeat(64),
        },
      ],
      revision: url.includes("new-cursor") ? "new" : "old",
      older: null,
    });
  }) as typeof auth.request;
  const refresh = store.history("session");
  await ready;
  const older = store.loadOlder("session");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const before = calls.filter((url) => url.includes("before="));
  finish({
    messages: [message],
    revision: "new",
    older: "new-cursor",
    anchorFound: true,
    anchoredOlder: "new-cursor",
  });
  await refresh;
  await older;
  assert.deepEqual(before, [], "No old snapshot request may start during refresh");
  assert.deepEqual(
    store.messages.session!.map((row) => row.content),
    ["Canonical older", "Current"],
  );
});

test("newer working status survives older metadata and lock clears it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
    location: { protocol: "https:", host: "fixture" },
    WebSocket: Socket,
  });
  setActivePinia(createPinia());
  const auth = useAuth();
  auth.unlocked = true;
  auth.visible = true;
  const store = useSessions();
  const saved = {
    sessionId: "session",
    epoch: 1,
    sequence: 1,
    state: "running",
    workingMessage: "Thinking...",
  } as Session;
  store.sessions = [saved];
  let finish!: (value: unknown) => void;
  auth.request = (() =>
    new Promise((resolve) => (finish = resolve))) as typeof auth.request;
  store.connect("session");
  const pending = store.detail("session");
  Socket.latest.onmessage?.({
    data: JSON.stringify({
      type: "working_status",
      sessionId: "session",
      sequence: 3,
      data: { message: "Bashing..." },
    }),
  });
  finish({ ...saved, sequence: 2, workingMessage: "Thinking..." });
  await pending;
  assert.equal(store.sessions[0]!.workingMessage, "Bashing...");
  Socket.latest.onmessage?.({
    data: JSON.stringify({
      type: "working_status",
      sessionId: "session",
      sequence: 4,
      data: { message: null },
    }),
  });
  assert.equal(store.sessions[0]!.workingMessage, undefined);
  store.homePosition = {
    top: 850,
    search: "private",
    anchor: { key: "private-row", offset: 120 },
  };
  auth.clear();
  assert.equal(store.homePosition, undefined);
  assert.deepEqual(store.sessions, []);
});

test("disconnect clears activity without losing drafts or history; delayed metadata cannot restore it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
    location: { protocol: "https:", host: "fixture" },
    WebSocket: Socket,
  });
  setActivePinia(createPinia());
  const auth = useAuth();
  auth.unlocked = true;
  auth.visible = true;
  const store = useSessions();
  const saved = {
    sessionId: "session",
    epoch: 1,
    sequence: 4,
    state: "running",
    workingMessage: "Thinking...",
  } as Session;
  store.sessions = [{ ...saved }];
  store.drafts.session = "Keep draft";
  store.messages.session = [{ role: "user", content: "Keep history" }];
  store.disconnect();
  assert.equal(store.sessions[0]!.workingMessage, undefined);
  assert.equal(store.drafts.session, "Keep draft");
  assert.equal(store.messages.session![0]!.content, "Keep history");
  store.connect("session");
  store.sessions[0]!.workingMessage = "Bashing...";
  let finish!: (value: unknown) => void;
  auth.request = (() =>
    new Promise((resolve) => (finish = resolve))) as typeof auth.request;
  const pending = store.detail("session");
  Socket.latest.onclose?.({ code: 1006 });
  assert.equal(store.sessions[0]!.workingMessage, undefined);
  finish(saved);
  await pending;
  assert.equal(store.sessions[0]!.workingMessage, undefined);
  assert.equal(store.drafts.session, "Keep draft");
});
test("a delayed equal-sequence detail cannot resurrect stopped activity", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
  });
  setActivePinia(createPinia());
  const auth = useAuth();
  auth.unlocked = true;
  const store = useSessions();
  const saved = {
    sessionId: "session",
    epoch: 1,
    sequence: 4,
    state: "running",
    workingMessage: "Bashing...",
  } as Session;
  store.sessions = [saved];
  const responses: ((value: unknown) => void)[] = [];
  auth.request = (() =>
    new Promise((resolve) => responses.push(resolve))) as typeof auth.request;
  const older = store.detail("session");
  const newer = store.detail("session");
  responses[1]!({ ...saved, state: "stopped", workingMessage: undefined });
  await newer;
  responses[0]!(saved);
  await older;
  assert.equal(store.sessions[0]!.state, "stopped");
  assert.equal(store.sessions[0]!.workingMessage, undefined);
});

test("subagent previews update in memory, settle to final results and clear on disconnect and lock", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
    location: { protocol: "https:", host: "fixture.test.ts.net" },
    WebSocket: Socket,
  });
  setActivePinia(createPinia());
  const auth = useAuth(),
    store = useSessions(),
    id = "c2d90aba-4820-494b-978d-1991e3e820cf";
  auth.unlocked = true;
  auth.visible = true;
  auth.request = (async () => []) as typeof auth.request;
  store.sessions = [{ sessionId: id, epoch: 1, sequence: 0 } as Session];
  const preview = (text: string) => ({
    toolCallId: "child",
    toolDisplay: `subagent Builder #2\n${text}`,
    toolDisplayStyles: ["plain", "plain"],
  });
  const emit = (type: string, data: unknown) =>
    Socket.latest.onmessage?.({
      data: JSON.stringify({ version: 1, sessionId: id, type, data }),
    });
  try {
    store.connect(id);
    Socket.latest.onopen?.();
    emit("tool_progress_snapshot", [preview("Reading source")]);
    assert.match(store.toolProgress[id]!.child!.toolDisplay, /Reading source/);
    emit("tool_progress", preview("Running tests"));
    assert.match(store.toolProgress[id]!.child!.toolDisplay, /Running tests/);
    assert.equal(store.messages[id], undefined);
    emit("message_end", {
      role: "toolResult",
      toolCallId: "child",
      toolName: "subagent",
      content: [{ type: "text", text: "Done" }],
    });
    assert.equal(store.toolProgress[id]!.child, undefined);
    assert.equal(store.messages[id]![0]!.role, "toolResult");

    emit("tool_progress", preview("Before empty snapshot"));
    emit("tool_progress_snapshot", []);
    assert.deepEqual(store.toolProgress[id], {});
    emit("tool_progress", preview("Before tool end"));
    emit("tool_execution_end", { toolCallId: "child" });
    assert.equal(store.toolProgress[id]!.child, undefined);
    emit("tool_progress", preview("Before same-epoch disconnection"));
    auth.request = (async () => ({
      sessionId: id,
      epoch: 1,
      sequence: 0,
      state: "stopped",
    })) as typeof auth.request;
    await store.detail(id);
    assert.equal(store.toolProgress[id], undefined);
    emit("tool_progress", preview("Late obsolete preview"));
    assert.equal(store.toolProgress[id], undefined);
    store.sessions[0]!.state = "running";
    emit("tool_progress", preview("Still running"));
    auth.visible = false;
    Socket.latest.onclose?.({ code: 4000 });
    assert.deepEqual(store.toolProgress, {});
    auth.visible = true;
    store.connect(id);
    Socket.latest.onopen?.();
    emit("tool_progress_snapshot", [preview("Restored current preview")]);
    assert.match(store.toolProgress[id]!.child!.toolDisplay, /Restored/);
    auth.clear();
    assert.deepEqual(store.toolProgress, {});
  } finally {
    auth.clear();
    mock.timers.reset();
  }
});

test("session.hidden purges every phone cache and fences late metadata and history", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
    location: { protocol: "https:", host: "fixture" },
    WebSocket: Socket,
  });
  setActivePinia(createPinia());
  const auth = useAuth(),
    store = useSessions();
  auth.unlocked = true;
  auth.visible = true;
  const sid = "private-session",
    other = "public-session";
  const row = { sessionId: sid, sequence: 1, epoch: 1, state: "waiting" } as never;
  store.sessions = [row];
  store.listing = [row];
  store.homeListing = [row];
  store.drafts[sid] = "private draft";
  store.drafts[other] = "keep public draft";
  store.messages[sid] = [{ role: "user", content: "private history" }];
  store.prompt[sid] = {
    id: "question",
    title: "private question",
    deadline: 9999999999999,
    state: "pending",
  };
  store.streaming[sid] = { content: "private live" };
  store.historyLimited[sid] = true;
  let metadata!: (value: unknown) => void, history!: (value: unknown) => void;
  auth.request = ((url: string) =>
    url === `/sessions/${sid}`
      ? new Promise((resolve) => (metadata = resolve))
      : url.includes("/history?")
        ? new Promise((resolve) => (history = resolve))
        : Promise.resolve([])) as typeof auth.request;
  try {
    store.connect(sid);
    const reading = store.history(sid),
      detail = store.detail(sid);
    Socket.latest.onmessage?.({
      data: JSON.stringify({
        version: 1,
        type: "session.hidden",
        sessionId: sid,
        data: null,
      }),
    });
    assert(store.isHidden(sid));
    assert.equal(store.sessions.length, 0);
    assert.equal(store.listing.length, 0);
    assert.equal(store.homeListing.length, 0);
    assert.equal(store.prompt[sid], undefined);
    assert.equal(store.drafts[sid], undefined);
    assert.equal(store.messages[sid], undefined);
    assert.equal(store.historyLimited[sid], undefined);
    metadata(row);
    history({
      messages: [{ role: "user", content: "late private history" }],
      revision: "late",
      older: null,
    });
    await Promise.all([detail, reading]);
    Socket.latest.onmessage?.({
      data: JSON.stringify({
        version: 1,
        type: "message_end",
        sessionId: sid,
        data: { role: "user", content: "late private event" },
      }),
    });
    assert.equal(store.sessions.length, 0);
    assert.equal(store.messages[sid], undefined);
    assert.equal(store.drafts[other], "keep public draft");
    await assert.rejects(
      store.command(sid, { action: "stop_run" }),
      /session_not_found/,
    );
  } finally {
    auth.clear();
    t.mock.timers.reset();
  }
});

test("live questions survive older HTTP snapshots and stale resolution or expiry", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  Object.assign(globalThis, {
    document: { visibilityState: "visible", addEventListener() {} },
    window: { addEventListener() {} },
    location: { protocol: "https:", host: "fixture" },
    WebSocket: Socket,
  });
  setActivePinia(createPinia());
  const auth = useAuth(),
    store = useSessions();
  auth.unlocked = true;
  auth.visible = true;
  const sid = "questions";
  store.sessions = [
    { sessionId: sid, epoch: 1, sequence: 1, state: "running" } as never,
  ];
  let release!: (value: unknown) => void;
  auth.request = ((url: string) =>
    url === `/sessions/${sid}`
      ? new Promise((resolve) => (release = resolve))
      : Promise.resolve([])) as typeof auth.request;
  try {
    store.connect(sid);
    const old = store.detail(sid);
    const question = {
      id: "new",
      title: "Current question",
      deadline: 9999999999999,
      state: "pending",
    };
    const send = (type: string, data: unknown, sequence: number) =>
      Socket.latest.onmessage?.({
        data: JSON.stringify({ version: 1, type, sessionId: sid, sequence, data }),
      });
    send("prompt", question, 4);
    release({ sessionId: sid, epoch: 1, sequence: 2, state: "running" });
    await old;
    assert.equal(store.prompt[sid]?.id, "new");
    send("prompt", { ...question, id: "old", state: "resolved" }, 3);
    send("prompt.expired", { id: "old" }, 3);
    assert.equal(store.prompt[sid]?.id, "new");
    assert.equal(store.prompt[sid]?.state, "pending");
    send("prompt", { ...question, state: "resolved" }, 5);
    assert.equal(store.prompt[sid], undefined);
  } finally {
    auth.clear();
    t.mock.timers.reset();
  }
});
