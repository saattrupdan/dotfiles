import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigSchema } from "../src/config.ts";
import { approvePilot, assertDeployment, attest, gates } from "../src/gates.ts";
import { assertInstalledRelease, assertStartup, sealRelease } from "../src/releases.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-"));
  const agentDir = path.join(root, "agent");
  const dataDir = path.join(root, "data");
  const release = path.join(dataDir, "releases", "fixture");
  fs.mkdirSync(path.join(agentDir, "remote/packages"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "agents"));
  fs.mkdirSync(release, { recursive: true });
  for (const name of [
    "broker.mjs",
    "run-managed.mjs",
    "cli.mjs",
    "web/index.html",
    "package-lock.json",
    "node_modules/fixture/index.js",
  ]) {
    const file = path.join(release, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture ${name}`);
  }
  fs.symlinkSync("fixture", path.join(release, "node_modules/linked-fixture"));
  const config = ConfigSchema.parse({
    origin: "https://release.test.ts.net",
    home: root,
    agentDir,
    dataDir,
    deploymentPolicy: "pilot",
    pilotScope: "laptop-main",
  });
  const evidence = path.join(root, "evidence.json");
  fs.writeFileSync(evidence, "{}");
  function approve() {
    for (const gate of ["automated", "session-controls-tui"])
      attest(config, gate, evidence);
    approvePilot(config, evidence);
    return gates(config).digest;
  }
  const digest = approve();
  return {
    root,
    config,
    release,
    digest,
    approve,
    entry: pathToFileURL(path.join(release, "broker.mjs")).href,
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("installed startup survives shared Pi source edits while new installs remain gated", () => {
  const f = fixture();
  try {
    sealRelease(f.config, f.release, f.digest);
    assertStartup(f.config, f.entry);
    fs.writeFileSync(
      path.join(f.config.agentDir, "agents/main.md"),
      "Changed shared Pi prompt",
    );
    fs.writeFileSync(
      path.join(f.config.agentDir, "remote/packages/new.ts"),
      "Changed source",
    );
    assert.throws(() => assertDeployment(f.config), /missing current evidence/);
    assert.doesNotThrow(() => assertStartup(f.config, f.entry));
    assert.throws(
      () => sealRelease(f.config, f.release, f.digest),
      /missing current evidence/,
    );
    // Later approvals may replace the evidence without revoking installed releases.
    f.approve();
    fs.unlinkSync(path.join(f.config.dataDir, "pilot-approval.json"));
    fs.unlinkSync(path.join(f.config.dataDir, "release-gates.json"));
    assertStartup(f.config, f.entry);
    assertInstalledRelease(f.config, f.release);
  } finally {
    f.close();
  }
});

test("installed startup through a symlinked data directory ignores subsequent source edits", () => {
  const f = fixture();
  try {
    const alias = path.join(f.root, "data-link");
    fs.symlinkSync(f.config.dataDir, alias);
    const config = { ...f.config, dataDir: alias };
    sealRelease(config, f.release, f.digest);
    fs.writeFileSync(path.join(f.config.agentDir, "agents/main.md"), "Changed");
    assertStartup(config, f.entry);
    assertStartup(
      config,
      pathToFileURL(path.join(alias, "releases/fixture/broker.mjs")).href,
    );
  } finally {
    f.close();
  }
});

test("installed approval stays bound to configuration and refuses legacy releases", () => {
  const f = fixture();
  try {
    sealRelease(f.config, f.release, f.digest);
    for (const change of [
      { origin: "https://other.test.ts.net" },
      { pilotScope: "fresh-managed-only" as const },
      { deploymentPolicy: "release" as const },
      { sessionDirectories: [f.root] },
      { home: f.config.dataDir },
      { webDir: f.root },
    ])
      assert.throws(
        () => assertInstalledRelease({ ...f.config, ...change }, f.release),
        /configuration changed/,
      );
    fs.writeFileSync(
      path.join(f.release, "release.json"),
      JSON.stringify({ digest: f.digest, protocol: 1, created: Date.now() }),
    );
    assert.throws(
      () => assertStartup(f.config, f.entry),
      /approval missing or incompatible/,
    );
  } finally {
    f.close();
  }
});

for (const name of [
  "broker.mjs",
  "run-managed.mjs",
  "cli.mjs",
  "web/index.html",
  "package-lock.json",
  "node_modules/fixture/index.js",
])
  test(`installed approval detects changes to ${name}`, () => {
    const f = fixture();
    try {
      sealRelease(f.config, f.release, f.digest);
      fs.appendFileSync(path.join(f.release, name), "tampered");
      assert.throws(
        () => assertInstalledRelease(f.config, f.release),
        /artifacts changed/,
      );
    } finally {
      f.close();
    }
  });

test("release sealing rejects source drift, external symlinks and paths outside releases", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.config.agentDir, "agents/main.md"), "Changed");
    f.approve();
    assert.throws(() => sealRelease(f.config, f.release, f.digest), /Sources changed/);
    const digest = gates(f.config).digest;
    fs.symlinkSync(f.config.agentDir, path.join(f.release, "outside"));
    assert.throws(() => sealRelease(f.config, f.release, digest), /external symlink/);
    fs.unlinkSync(path.join(f.release, "outside"));
    assert.throws(() => sealRelease(f.config, f.root, digest), /releases directory/);
  } finally {
    f.close();
  }
});

test("source startup and proof mode still require current source approval", () => {
  const f = fixture();
  try {
    sealRelease(f.config, f.release, f.digest);
    const source = pathToFileURL(
      path.join(f.config.agentDir, "remote/packages/broker/src/main.ts"),
    ).href;
    assertStartup(f.config, source);
    assert.throws(() => assertStartup(f.config, f.entry, true), /pilot-proof-conflict/);
    fs.writeFileSync(path.join(f.config.agentDir, "agents/main.md"), "Changed");
    assert.throws(() => assertStartup(f.config, source), /missing current evidence/);
  } finally {
    f.close();
  }
});
