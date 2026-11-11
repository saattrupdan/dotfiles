import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useSessions } from "../src/frontend/stores/sessions.ts";
import { useAuth } from "../src/frontend/stores/auth.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const credential = () => ({
  id: "Y3JlZGVudGlhbA",
  rawId: new Uint8Array([1]).buffer,
  type: "public-key",
  authenticatorAttachment: "platform",
  getClientExtensionResults: () => ({}),
  response: {
    authenticatorData: new Uint8Array([1]).buffer,
    clientDataJSON: new TextEncoder().encode("{}").buffer,
    signature: new Uint8Array([1]).buffer,
    userHandle: null,
  },
});
function fixture(get: () => Promise<unknown> = async () => credential()) {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const documentEvents: Record<string, () => void> = {};
  const windowEvents: Record<string, () => void> = {};
  const doc = {
    visibilityState: "visible",
    addEventListener: (name: string, fn: () => void) => (documentEvents[name] = fn),
  };
  const globals = {
    document: doc,
    window: {
      addEventListener: (name: string, fn: () => void) => (windowEvents[name] = fn),
    },
    location: { hash: "", hostname: "fixture.test.ts.net" },
    PublicKeyCredential: class {},
    navigator: { credentials: { get }, userAgent: "Firefox" },
  };
  const previous = new Map(
    Object.keys(globals).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
    });
  const calls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    const body = url.endsWith("/me")
      ? { paired: true, csrf: "fixture", device: "iPhone" }
      : url.endsWith("/auth/options")
        ? {
            ceremony: "fixture",
            options: {
              challenge: "Y2hhbGxlbmdl",
              rpId: "fixture.test.ts.net",
              userVerification: "required",
              hints: ["client-device"],
              allowCredentials: [
                { id: "Y3JlZGVudGlhbA", type: "public-key", transports: ["internal"] },
              ],
            },
          }
        : { verified: true, unlocked: true };
    return new Response(JSON.stringify(body));
  });
  setActivePinia(createPinia());
  const auth = useAuth();
  return {
    auth,
    calls,
    doc,
    documentEvents,
    windowEvents,
    close() {
      auth.clear();
      mock.restoreAll();
      mock.timers.reset();
      for (const [name, descriptor] of previous)
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    },
  };
}

test("a paired app opens and resumes without calling biometric browser APIs", async () => {
  let prompts = 0;
  const f = fixture(async () => {
    prompts++;
    throw new Error("No biometrics");
  });
  try {
    await f.auth.initialize();
    assert(f.auth.unlocked);
    assert.equal(prompts, 0);
    assert.equal(f.calls.filter((url) => url.endsWith("/auth/unlock")).length, 1);
    f.windowEvents.pagehide!();
    f.documentEvents.visibilitychange!();
    await flush();
    await flush();
    assert(f.auth.unlocked);
    assert.equal(prompts, 0);
    assert.equal(f.calls.filter((url) => url.endsWith("/auth/unlock")).length, 2);
    assert(!f.calls.some((url) => /auth\/(options|assert)/.test(url)));
  } finally {
    f.close();
  }
});

test("automatic opening is single-flight and abandoned responses cannot reopen private data", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  let finish!: (response: Response) => void;
  let opens = 0;
  mock.method(globalThis, "fetch", (url: string, options: RequestInit) => {
    if (url.endsWith("/auth/unlock")) {
      opens++;
      return new Promise((resolve) => (finish = resolve));
    }
    return original(url, options);
  });
  try {
    const first = f.auth.initialize();
    await flush();
    const second = f.auth.unlock();
    assert.equal(opens, 1);
    f.auth.clear();
    finish(new Response(JSON.stringify({ unlocked: true })));
    await first;
    await second;
    assert(!f.auth.unlocked);
    assert(!f.auth.verifying);
  } finally {
    f.close();
  }
});

test("unpaired opening never asks for biometrics or activates a device", async () => {
  const f = fixture(async () => {
    throw new Error("No biometric calls");
  });
  mock.method(globalThis, "fetch", async (url: string) => {
    f.calls.push(url);
    return new Response(JSON.stringify({ paired: false }));
  });
  try {
    await f.auth.initialize();
    assert(!f.auth.unlocked);
    assert(!f.auth.paired);
    assert.deepEqual(f.calls, ["/api/v1/me"]);
  } finally {
    f.close();
  }
});

test("foreground queues a fresh paired-device opening after an invalidated request", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  let finish!: (response: Response) => void;
  let opens = 0;
  mock.method(globalThis, "fetch", (url: string, options: RequestInit) => {
    if (url.endsWith("/auth/unlock") && ++opens === 1)
      return new Promise((resolve) => (finish = resolve));
    return original(url, options);
  });
  try {
    const first = f.auth.initialize();
    await flush();
    f.windowEvents.pagehide!();
    f.documentEvents.visibilitychange!();
    f.documentEvents.visibilitychange!();
    await first;
    await flush();
    finish(new Response(JSON.stringify({ unlocked: true })));
    await flush();
    assert.equal(opens, 2);
    assert(f.auth.unlocked);
  } finally {
    f.close();
  }
});

test("a stalled startup becomes a retryable connection error instead of hanging", async () => {
  const f = fixture();
  mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        options.signal!.addEventListener(
          "abort",
          () => reject(options.signal!.reason),
          { once: true },
        );
      }),
  );
  const initialization = f.auth.initialize();
  try {
    mock.timers.tick(10001);
    await flush();
    assert.equal(f.auth.initializing, false);
    assert.equal(f.auth.online, false);
    assert.match(f.auth.error, /connect|unreachable|offline/i);
    assert.equal(f.auth.unlocked, false);
  } finally {
    f.auth.clear();
    await initialization;
    f.close();
  }
});

test("offline startup fails immediately without making requests or prompting for a passkey", async () => {
  const f = fixture();
  Object.assign(navigator, { onLine: false });
  try {
    await f.auth.initialize();
    assert.equal(f.auth.online, false);
    assert.equal(f.auth.initializing, false);
    assert.equal(f.auth.unlocked, false);
    assert.deepEqual(f.calls, []);
  } finally {
    f.close();
  }
});

test("timed out writes release their spinner without automatically submitting again", async () => {
  const f = fixture();
  let posts = 0;
  mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    posts++;
    return new Promise((_resolve, reject) =>
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
        once: true,
      }),
    );
  });
  try {
    const result = f.auth.request("/sessions/fixture/actions", {
      method: "POST",
      body: "{}",
    });
    const rejected = assert.rejects(result, /connect/i);
    assert.equal(f.auth.pending, 1);
    mock.timers.tick(30001);
    await rejected;
    assert.equal(posts, 1);
    assert.equal(f.auth.pending, 0);
    assert.equal(f.auth.online, false);
  } finally {
    f.close();
  }
});

test("an already cancelled request never starts a fetch or leaves a spinner", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      f.auth.request("/sessions", { method: "POST", signal: controller.signal }),
    );
    assert.equal(f.auth.pending, 0);
    assert.deepEqual(f.calls, []);
  } finally {
    f.close();
  }
});

test("a completed foreground return clears its old background deadline and preserves drafts", async () => {
  const f = fixture();
  let now = Date.now();
  mock.method(Date, "now", () => now);
  try {
    await f.auth.initialize();
    const store = useSessions();
    store.drafts.fixture = "Keep this draft";
    f.doc.visibilityState = "hidden";
    f.documentEvents.visibilitychange!();
    await flush();
    now += 1000;
    f.doc.visibilityState = "visible";
    f.documentEvents.visibilitychange!();
    await flush();
    now += 180000;
    mock.timers.tick(15000);
    await flush();
    await flush();
    assert.equal(store.drafts.fixture, "Keep this draft");
    assert.equal(f.calls.filter((url) => url.endsWith("/auth/unlock")).length, 1);
    assert(f.auth.unlocked);
  } finally {
    f.close();
  }
});
