import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { Store, digest } from "../src/store.ts";
import { ConfigSchema } from "../src/config.ts";
import { createBroker } from "../src/server.ts";
import { homeDirectory, uploadImage } from "../src/files.ts";
import { attest, gates } from "../src/gates.ts";
import { Envelope } from "../../protocol/src/index.ts";
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-test-"));
const origin = "https://fixture.test.ts.net";
test("conventional icon endpoints serve public image bytes, never the SPA fallback", async () => {
  const dir = fixture();
  const webDir = path.join(dir, "web");
  fs.cpSync(new URL("../../web/public/", import.meta.url), webDir, { recursive: true });
  fs.copyFileSync(
    new URL("../../web/index.html", import.meta.url),
    path.join(webDir, "index.html"),
  );
  const broker = await createBroker(
    ConfigSchema.parse({ origin, dataDir: path.join(dir, "data"), home: dir, webDir }),
    { ipc: false, history: false },
  );
  try {
    for (const url of [
      "/apple-touch-icon.png",
      "/favicon-16x16.png",
      "/favicon-32x32.png",
      "/favicon.ico",
      "/icons/pi-1024.png",
    ]) {
      const response = await broker.app.inject({
        url,
        headers: { host: new URL(origin).host },
      });
      assert.equal(response.statusCode, 200, url);
      assert.match(
        String(response.headers["content-type"]),
        url.endsWith(".ico") ? /^image\/(?:x-icon|vnd.microsoft.icon)/ : /^image\/png/,
        url,
      );
      assert.deepEqual(
        response.rawPayload,
        fs.readFileSync(path.join(webDir, url.slice(1))),
        url,
      );
      assert(!response.headers["set-cookie"]);
      const head = await broker.app.inject({
        method: "HEAD",
        url,
        headers: { host: new URL(origin).host },
      });
      assert.equal(head.statusCode, 200, url);
      assert.equal(head.headers["content-type"], response.headers["content-type"], url);
      assert.equal(head.payload, "");
    }
    assert.equal(
      (
        await broker.app.inject({
          url: "/api/v1/sessions",
          headers: { host: new URL(origin).host },
        })
      ).statusCode,
      401,
    );
  } finally {
    await broker.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("journal deduplicates identical IDs and refuses changed intent", () => {
  const dir = fixture();
  const store = new Store(dir);
  try {
    const envelope = Envelope.parse({
      version: 1,
      commandId: randomUUID(),
      sessionId: randomUUID(),
      epoch: 1,
      command: { action: "message", text: "Hello" },
    });
    store.journal(envelope, "device");
    store.status(envelope.commandId, "delivery_unknown");
    assert.equal(store.journal(envelope, "device").status, "delivery_unknown");
    assert.throws(() => store.journal({ ...envelope, epoch: 2 }, "device"), /conflict/);
    assert.throws(() => store.journal(envelope, "other"), /conflict/);
    store.status(envelope.commandId, "persisted");
    store.status(envelope.commandId, "delivery_unknown");
    assert.equal(store.command(envelope.commandId)?.status, "persisted");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("home browser canonicalizes and rejects symlink escapes", () => {
  const dir = fixture();
  try {
    fs.mkdirSync(path.join(dir, "child"));
    fs.symlinkSync(os.tmpdir(), path.join(dir, "outside"));
    assert.equal(
      homeDirectory(path.join(dir, "child", ".."), dir),
      fs.realpathSync(dir),
    );
    assert.throws(() => homeDirectory(path.join(dir, "outside"), dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("images are decoded, normalized and bounded; documents rejected", async () => {
  const dir = fixture();
  const config = ConfigSchema.parse({ origin, dataDir: dir, home: dir });
  fs.mkdirSync(path.join(dir, "attachments"));
  const store = new Store(dir);
  try {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .jpeg()
      .toBuffer();
    const result = await uploadImage(bytes, randomUUID(), "device", config, store);
    assert.equal(result.mime, "image/png");
    assert.equal(
      fs.statSync(path.join(dir, "attachments", `${result.id}.png`)).mode & 0o777,
      0o600,
    );
    await assert.rejects(
      uploadImage(Buffer.from("%PDF-1.4"), randomUUID(), "device", config, store),
      /unsupported_image/,
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("release gates expire when source changes", () => {
  const dir = fixture();
  try {
    fs.mkdirSync(path.join(dir, "remote", "packages"), { recursive: true });
    const source = path.join(dir, "remote", "packages", "source.ts");
    fs.writeFileSync(source, "first");
    const evidence = path.join(dir, "evidence.json");
    fs.writeFileSync(evidence, "{}");
    const config = { agentDir: dir, dataDir: path.join(dir, "data") };
    attest(config, "automated", evidence);
    assert(!gates(config).missing.includes("automated"));
    fs.writeFileSync(source, "second");
    assert(gates(config).missing.includes("automated"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("release gates cover imported Firefox handoff and profile helpers", () => {
  const dir = fixture();
  try {
    const browser = path.join(dir, "extensions", "web-browse");
    fs.mkdirSync(browser, { recursive: true });
    const evidence = path.join(dir, "evidence.json");
    fs.writeFileSync(evidence, "{}");
    const config = { agentDir: dir, dataDir: path.join(dir, "data") };
    for (const name of ["firefox-session.ts", "profile.ts", "snapshot.ts"]) {
      const source = path.join(browser, name);
      fs.writeFileSync(source, "first");
      attest(config, "automated", evidence);
      assert(!gates(config).missing.includes("automated"));
      fs.writeFileSync(source, "second");
      assert(gates(config).missing.includes("automated"), name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
for (const deploymentPolicy of ["release", "pilot"] as const)
  test(`HTTP authentication, origin, lock, CSRF, grace and revocation (${deploymentPolicy})`, async () => {
    const dir = fixture();
    const config = ConfigSchema.parse({
      origin,
      dataDir: dir,
      home: dir,
      deploymentPolicy,
    });
    const broker = await createBroker(config, { ipc: false, history: false });
    const host = new URL(origin).host;
    const request = (
      method: "GET" | "POST",
      url: string,
      extra: Record<string, string> = {},
      payload?: Record<string, unknown>,
    ) =>
      broker.app.inject({
        method,
        url,
        headers: { host, ...(method === "POST" ? { origin } : {}), ...extra },
        payload,
      });
    try {
      assert.equal((await request("GET", "/api/v1/sessions")).statusCode, 401);
      assert.equal(
        (
          await request(
            "POST",
            "/api/v1/auth/options",
            { origin: "https://evil.example" },
            {},
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (await request("GET", "/api/v1/me", { host: "evil.example" })).statusCode,
        403,
      );
      const id = randomUUID(),
        raw = "cookie-secret",
        csrf = "csrf-secret",
        now = Date.now();
      broker.store.db
        .prepare("INSERT INTO devices VALUES (?,?,?,0,?)")
        .run(id, "Phone", "{}", now);
      broker.store.db
        .prepare("INSERT INTO auth VALUES (?,?,?,?,?,?,?,?)")
        .run(digest(raw), id, csrf, now, now, null, now + 86400000, 1);
      const headers = { cookie: `__Host-pi-remote=${raw}`, "x-pi-csrf": csrf };
      const response = await request("GET", "/api/v1/sessions", headers);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(
        (await request("POST", "/api/v1/auth/lock", { cookie: headers.cookie }, {}))
          .statusCode,
        403,
      );
      assert.equal(
        (await request("POST", "/api/v1/auth/presence", headers, { foreground: false }))
          .statusCode,
        200,
      );
      assert.equal((await request("GET", "/api/v1/sessions", headers)).statusCode, 423);
      assert.equal(
        (await request("POST", "/api/v1/auth/presence", headers, { foreground: true }))
          .statusCode,
        200,
      );
      broker.store.db
        .prepare("UPDATE auth SET background=?,seen=?")
        .run(now - 121000, now - 121000);
      assert.equal(
        (await request("POST", "/api/v1/auth/presence", headers, { foreground: true }))
          .statusCode,
        423,
      );
      broker.store.db
        .prepare("UPDATE auth SET unlocked=1,background=NULL,seen=?")
        .run(Date.now());
      broker.store.db
        .prepare("UPDATE auth SET verified=?,seen=?,unlocked=1,background=NULL")
        .run(Date.now() - 901000, Date.now());
      assert.equal((await request("GET", "/api/v1/sessions", headers)).statusCode, 423);
      assert.equal(
        (await request("POST", "/api/v1/auth/presence", headers, { foreground: true }))
          .statusCode,
        423,
      );
      broker.auth.revoke(id);
      assert.equal((await request("GET", "/api/v1/sessions", headers)).statusCode, 401);
    } finally {
      await broker.app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
test("pair links last ten minutes and remain single-use; passkey ceremonies stay short", async (t) => {
  const dir = fixture();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const broker = await createBroker(
    ConfigSchema.parse({ origin, dataDir: dir, home: dir }),
    { ipc: false, history: false },
  );
  const pair = async () =>
    (await broker.owners.onAdmin!("pair", {})) as { url: string; expiresAt: number };
  const request = (url: string, payload: Record<string, string>) =>
    broker.app.inject({
      method: "POST",
      url,
      headers: { host: new URL(origin).host, origin },
      payload,
    });
  try {
    const link = await pair();
    assert.equal(link.expiresAt - now, 10 * 60 * 1000);
    const secret = new URL(link.url).hash.slice(1);
    const saved = broker.store.db
      .prepare("SELECT expires FROM challenges WHERE id=? AND purpose='pair'")
      .get(digest(secret)) as { expires: number };
    assert.equal(saved.expires, link.expiresAt);
    now += 10 * 60 * 1000 - 1;
    const options = await request("/api/v1/pairing/options", {
      token: secret,
      name: "Phone",
    });
    assert.equal(options.statusCode, 200);
    const ceremony = options.json().ceremony as string;
    const registration = broker.store.db
      .prepare("SELECT expires FROM challenges WHERE id=? AND purpose='registration'")
      .get(ceremony) as { expires: number };
    assert.equal(registration.expires - now, 120000);
    assert.equal(
      (await request("/api/v1/pairing/options", { token: secret, name: "Phone" }))
        .statusCode,
      401,
    );
    const expired = await pair();
    now = expired.expiresAt;
    const rejected = await request("/api/v1/pairing/options", {
      token: new URL(expired.url).hash.slice(1),
      name: "Phone",
    });
    assert.equal(rejected.statusCode, 401);
    assert.equal(rejected.json().error, "pairing_expired");
    const assertion = await request("/api/v1/auth/options", {});
    assert.equal(assertion.statusCode, 200);
    const assertionExpiry = broker.store.db
      .prepare("SELECT expires FROM challenges WHERE id=? AND purpose='assert'")
      .get(assertion.json().ceremony) as { expires: number };
    assert.equal(assertionExpiry.expires - now, 120000);
  } finally {
    await broker.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("pairing challenges expire and are consumed atomically", () => {
  const dir = fixture();
  const store = new Store(dir);
  try {
    const id = store.challenge("pair", "proof");
    assert(store.take(id, "pair"));
    assert.equal(store.take(id, "pair"), undefined);
    const expired = store.challenge("pair", "proof", "", randomUUID(), -1);
    assert.equal(store.take(expired, "pair"), undefined);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
