import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigSchema } from "../src/config.ts";
import {
  approvePilot,
  assertDeployment,
  assertRelease,
  attest,
  deployment,
  gates,
  REQUIRED,
} from "../src/gates.ts";
import { inDeploymentScope } from "../src/deployment-scope.ts";
import { createBroker } from "../src/server.ts";
import { Store, digest } from "../src/store.ts";
import { Owners } from "../src/ipc.ts";
import {
  acquire,
  newOwner,
} from "../../../../extensions/_session_ownership/ownership.mjs";
import { resolvePiPackage } from "../../../../profile/pi-runtime.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pilot-"));
  const agentDir = path.join(root, "agent");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(agentDir, "remote/packages"), { recursive: true });
  fs.mkdirSync(dataDir);
  const config = ConfigSchema.parse({
    origin: "https://pilot.test.ts.net",
    dataDir,
    agentDir,
    home: root,
    deploymentPolicy: "pilot",
  });
  const evidence = path.join(root, "approval.json");
  fs.writeFileSync(
    evidence,
    JSON.stringify({ approved: true, scope: "fresh-managed-only" }),
  );
  return {
    root,
    config,
    evidence,
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("pilot approval is separate from full release and still requires automated ownership proofs", () => {
  const f = fixture();
  try {
    assert.equal(
      ConfigSchema.parse({ origin: f.config.origin }).deploymentPolicy,
      "release",
    );
    assert.throws(() =>
      approvePilot({ ...f.config, deploymentPolicy: "release" }, f.evidence),
    );
    approvePilot(f.config, f.evidence);
    assert.throws(() => assertDeployment(f.config), /automated.*ownership-tui/);
    for (const name of ["automated", "ownership-tui"])
      attest(f.config, name, f.evidence);
    assertDeployment(f.config);
    assert.deepEqual(
      gates(f.config).missing,
      REQUIRED.filter((n) => n !== "automated" && n !== "ownership-tui"),
    );
    assert.throws(() => assertRelease(f.config), /iphone-webauthn/);
    assert.throws(
      () => assertDeployment({ ...f.config, deploymentPolicy: "release" }),
      /iphone-webauthn/,
    );
    assert.throws(() => assertDeployment(f.config, true), /pilot-proof-conflict/);
    fs.mkdirSync(path.join(f.config.dataDir, "ownership"));
    fs.writeFileSync(path.join(f.config.dataDir, "ownership/enabled"), "1");
    assert.throws(() => assertDeployment(f.config), /pilot-global-ownership-conflict/);
  } finally {
    f.close();
  }
});

test("pilot approval fails closed on missing, malformed, changed source, origin, destination or evidence", () => {
  const f = fixture();
  try {
    assert(deployment(f.config).missing.includes("pilot-approval"));
    const file = path.join(f.config.dataDir, "pilot-approval.json");
    fs.writeFileSync(file, "{}");
    assert(deployment(f.config).missing.includes("pilot-approval"));
    approvePilot(f.config, f.evidence);
    const original = fs.readFileSync(file);
    assert(!deployment(f.config).missing.includes("pilot-approval"));
    assert(
      deployment({ ...f.config, origin: "https://other.test.ts.net" }).missing.includes(
        "pilot-approval",
      ),
    );
    const other = path.join(f.root, "other");
    fs.mkdirSync(other);
    fs.copyFileSync(file, path.join(other, "pilot-approval.json"));
    assert(
      deployment({ ...f.config, dataDir: other }).missing.includes("pilot-approval"),
    );
    fs.writeFileSync(f.evidence, "changed");
    assert(deployment(f.config).missing.includes("pilot-approval"));
    fs.writeFileSync(
      f.evidence,
      JSON.stringify({ approved: true, scope: "fresh-managed-only" }),
    );
    fs.writeFileSync(
      path.join(f.config.agentDir, "remote/packages/changed.ts"),
      "changed",
    );
    assert(deployment(f.config).missing.includes("pilot-approval"));
    fs.writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(original.toString()), scope: "all-existing" }),
    );
    assert(deployment(f.config).missing.includes("pilot-approval"));
  } finally {
    f.close();
  }
});

test("pilot history scope rejects local histories and symlink escapes, including allocated new files", () => {
  const f = fixture();
  try {
    const dir = path.join(f.config.dataDir, "native-sessions");
    fs.mkdirSync(dir);
    const own = {
      managed: true,
      tmux: "pi-remote-fixture",
      sessionFile: path.join(dir, "new.jsonl"),
    };
    assert(inDeploymentScope(f.config, own));
    assert(!inDeploymentScope(f.config, { ...own, managed: false }));
    assert(!inDeploymentScope(f.config, { ...own, tmux: undefined }));
    const old = path.join(f.root, "existing.jsonl");
    fs.writeFileSync(old, "{}");
    assert(!inDeploymentScope(f.config, { ...own, sessionFile: old }));
    fs.symlinkSync(old, own.sessionFile);
    assert(!inDeploymentScope(f.config, own));
    assert(
      inDeploymentScope(
        { ...f.config, deploymentPolicy: "release" },
        { ...own, managed: false },
      ),
    );
  } finally {
    f.close();
  }
});

test("pilot does not expose or recover existing native histories", async () => {
  const f = fixture();
  const broker = await createBroker(f.config, { ipc: false });
  try {
    const device = randomUUID(),
      raw = randomUUID(),
      csrf = randomUUID(),
      now = Date.now();
    broker.store.db
      .prepare("INSERT INTO devices VALUES (?,?,?,0,?)")
      .run(device, "Fixture", "{}", now);
    broker.store.db
      .prepare("INSERT INTO auth VALUES (?,?,?,?,?,?,?,?)")
      .run(digest(raw), device, csrf, now, now, null, now + 86400000, 1);
    const id = randomUUID();
    const headers = {
      host: new URL(f.config.origin).host,
      origin: f.config.origin,
      cookie: `__Host-pi-remote=${raw}`,
      "x-pi-csrf": csrf,
    };
    assert.deepEqual(
      (await broker.app.inject({ url: "/api/v1/sessions", headers })).json(),
      [],
    );
    for (const suffix of ["", "/history", "/recover"]) {
      const response = await broker.app.inject({
        method: suffix === "/recover" ? "POST" : "GET",
        url: `/api/v1/sessions/${id}${suffix}`,
        headers,
      });
      assert.equal(response.statusCode, 404);
    }
  } finally {
    await broker.app.close();
    f.close();
  }
});

test("fresh unflushed native history opens as an empty conversation", async () => {
  const f = fixture();
  const directory = path.join(f.config.dataDir, "native-sessions");
  fs.mkdirSync(directory);
  const { SessionManager } = await import(
    pathToFileURL(path.join(resolvePiPackage(), "dist/core/session-manager.js")).href
  );
  const native = SessionManager.create(f.root, directory);
  const broker = await createBroker(f.config, { ipc: false });
  try {
    const device = randomUUID(),
      raw = randomUUID(),
      csrf = randomUUID(),
      now = Date.now();
    broker.store.db
      .prepare("INSERT INTO devices VALUES (?,?,?,0,?)")
      .run(device, "Fixture", "{}", now);
    broker.store.db
      .prepare("INSERT INTO auth VALUES (?,?,?,?,?,?,?,?)")
      .run(digest(raw), device, csrf, now, now, null, now + 86400000, 1);
    const id = native.getSessionId(),
      file = native.getSessionFile()!;
    assert.equal(fs.existsSync(file), false);
    broker.store.save({
      version: 1,
      ...newOwner(),
      sessionId: id,
      sessionFile: file,
      cwd: f.root,
      name: "New",
      managed: true,
      tmux: "pi-remote-fixture",
      model: "fixture/model",
      thinking: "off",
      capabilities: [],
      idle: true,
      loop: false,
      epoch: 1,
      sequence: 0,
      state: "idle",
      lastActivity: now,
    });
    const headers = {
      host: new URL(f.config.origin).host,
      cookie: `__Host-pi-remote=${raw}`,
    };
    const response = await broker.app.inject({
      url: `/api/v1/sessions/${id}/history`,
      headers,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      messages: [],
      offset: 0,
      next: null,
      total: 0,
    });
    assert.equal(fs.existsSync(file), false);
  } finally {
    await broker.app.close();
    f.close();
  }
});

test("pilot IPC rejects unmanaged and out-of-scope owners but accepts verified new managed histories", async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.config.dataDir, "native-sessions"));
  const store = new Store(f.config.dataDir),
    owners = new Owners(f.config, store, () => {}),
    owner = newOwner();
  const file = path.join(f.config.dataDir, "native-sessions/session.jsonl");
  const id = randomUUID();
  fs.writeFileSync(file, JSON.stringify({ type: "session", id }));
  acquire(file, owner, path.join(f.config.dataDir, "ownership"));
  await owners.listen();
  const base = {
    version: 1,
    ...owner,
    sessionId: id,
    sessionFile: file,
    cwd: f.root,
    name: "Fixture",
    managed: true,
    tmux: "pi-remote-fixture",
    model: "fixture/model",
    thinking: "off",
    capabilities: [],
    idle: true,
    loop: false,
  };
  try {
    for (const registration of [
      { ...base, managed: false },
      { ...base, sessionFile: path.join(f.root, "old.jsonl") },
      base,
    ]) {
      const socket = net.connect(path.join(f.config.dataDir, "broker.sock"));
      let buffer = "";
      const received: string[] = [];
      socket.on("data", (data) => {
        buffer += data;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          received.push(JSON.parse(buffer.slice(0, end)).type);
          buffer = buffer.slice(end + 1);
        }
      });
      const wait = async (check: () => boolean) => {
        for (let n = 0; n < 100; n++) {
          if (check()) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("IPC timeout");
      };
      try {
        socket.write(JSON.stringify({ secret: owners.secret }) + "\n");
        await wait(() => received.includes("ready"));
        socket.write(JSON.stringify({ type: "register", data: registration }) + "\n");
        if (registration === base) {
          await wait(() => received.includes("registered"));
          assert.equal(store.session(id)?.sessionFile, file);
        } else {
          await wait(() => socket.destroyed);
          assert.equal(store.sessions().length, 0);
        }
      } finally {
        socket.destroy();
      }
    }
  } finally {
    await owners.close();
    store.close();
    f.close();
  }
});

for (const deploymentPolicy of ["pilot", "release"] as const)
  test(`CLI ${deploymentPolicy} install preserves global ownership enablement policy`, () => {
    const f = fixture();
    try {
      f.config.deploymentPolicy = deploymentPolicy;
      const bin = path.join(f.root, "bin");
      fs.mkdirSync(bin);
      fs.symlinkSync(process.execPath, path.join(bin, "node"));
      for (const name of ["launchctl", "plutil", "ps"])
        fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      fs.writeFileSync(
        path.join(bin, "npm"),
        "#!/bin/sh\nif [ \"$1\" = run ]; then mkdir -p dist; printf 'console.log(1)' > dist/broker.mjs; fi\n",
        { mode: 0o700 },
      );
      f.config.node = path.join(bin, "node");
      for (const name of ["package.json", "package-lock.json"])
        fs.writeFileSync(path.join(f.config.agentDir, "remote", name), "{}");
      for (const name of ["broker", "cli", "protocol", "web"]) {
        const dir = path.join(f.config.agentDir, "remote/packages", name);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "package.json"), "{}");
      }
      const configFile = path.join(f.config.dataDir, "config.json");
      fs.writeFileSync(configFile, JSON.stringify(f.config));
      for (const name of deploymentPolicy === "pilot"
        ? ["automated", "ownership-tui"]
        : REQUIRED)
        attest(f.config, name, f.evidence);
      if (deploymentPolicy === "pilot") approvePilot(f.config, f.evidence);
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)),
          "install",
          "--config",
          configFile,
        ],
        {
          env: {
            ...process.env,
            HOME: f.root,
            PATH: bin + path.delimiter + process.env.PATH,
            PI_CLI_PACKAGE: resolvePiPackage(),
          },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        fs.existsSync(path.join(f.config.dataDir, "ownership/enabled")),
        deploymentPolicy === "release",
      );
    } finally {
      f.close();
    }
  });
