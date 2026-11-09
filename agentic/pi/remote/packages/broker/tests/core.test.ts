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
test("HTTP authentication, origin, lock, CSRF, grace and revocation", async () => {
  const dir = fixture();
  const config = ConfigSchema.parse({ origin, dataDir: dir, home: dir });
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
