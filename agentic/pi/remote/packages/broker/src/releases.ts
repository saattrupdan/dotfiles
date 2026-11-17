import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Config } from "./config.ts";
import { assertDeployment, gates } from "./gates.ts";

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Manifest = z
  .object({
    version: z.literal(2),
    protocol: z.literal(1),
    digest: hashSchema,
    artifacts: hashSchema,
    config: hashSchema,
    created: z.number().int().positive(),
  })
  .strict();

function configuration(config: Config) {
  return sha256(
    JSON.stringify({
      ...config,
      dataDir: fs.realpathSync(config.dataDir),
      agentDir: fs.realpathSync(config.agentDir),
      home: path.resolve(config.home),
      sessionDirectories: config.sessionDirectories
        .map((dir) => fs.realpathSync(dir))
        .sort(),
    }),
  );
}

function releaseDirectory(config: Config, directory: string) {
  const root = fs.realpathSync(path.join(config.dataDir, "releases"));
  const release = fs.realpathSync(directory);
  if (path.dirname(release) !== root)
    throw new Error("Release must be installed in the releases directory");
  return release;
}

function artifactDigest(directory: string) {
  const hash = createHash("sha256");
  function add(relative: string) {
    const file = path.join(directory, relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(file);
      if (!target.startsWith(directory + path.sep))
        throw new Error("Release contains an external symlink");
      hash.update(JSON.stringify([relative, "link", fs.readlinkSync(file)]));
    } else if (stat.isDirectory()) {
      hash.update(JSON.stringify([relative, "directory"]));
      for (const name of fs.readdirSync(file).sort()) add(path.join(relative, name));
    } else if (stat.isFile()) {
      hash.update(JSON.stringify([relative, "file", sha256(fs.readFileSync(file))]));
    } else throw new Error("Release contains a non-file artifact");
  }
  for (const name of fs.readdirSync(directory).sort())
    if (name !== "release.json") add(name);
  return hash.digest("hex");
}

// Installation approves current sources; startup checks the sealed installed files.
export function sealRelease(config: Config, directory: string, expectedDigest: string) {
  assertDeployment(config);
  const digest = gates(config).digest;
  if (digest !== expectedDigest)
    throw new Error("Sources changed while staging release");
  const release = releaseDirectory(config, directory);
  for (const name of [
    "broker.mjs",
    "run-managed.mjs",
    "cli.mjs",
    "web/index.html",
    "package-lock.json",
  ])
    if (!fs.statSync(path.join(release, name)).isFile())
      throw new Error(`Release artifact missing: ${name}`);
  const manifest = Manifest.parse({
    version: 2,
    protocol: 1,
    digest,
    artifacts: artifactDigest(release),
    config: configuration(config),
    created: Date.now(),
  });
  fs.writeFileSync(path.join(release, "release.json"), JSON.stringify(manifest), {
    mode: 0o600,
  });
}

export function assertInstalledRelease(config: Config, directory: string) {
  const release = releaseDirectory(config, directory);
  let manifest;
  try {
    manifest = Manifest.parse(
      JSON.parse(fs.readFileSync(path.join(release, "release.json"), "utf8")),
    );
  } catch {
    throw new Error(
      "Release approval missing or incompatible; reinstall with current validation",
    );
  }
  if (manifest.config !== configuration(config))
    throw new Error(
      "Installed release configuration changed; reinstall with current validation",
    );
  if (manifest.artifacts !== artifactDigest(release))
    throw new Error(
      "Installed release artifacts changed; reinstall with current validation",
    );
}

export function assertStartup(config: Config, entry: string, proof = false) {
  const file = fileURLToPath(entry);
  const releases = path.join(config.dataDir, "releases");
  if (!proof && path.basename(file) === "broker.mjs" && fs.existsSync(releases)) {
    const canonical = fs.realpathSync(file);
    if (canonical.startsWith(fs.realpathSync(releases) + path.sep)) {
      assertInstalledRelease(config, path.dirname(canonical));
      return;
    }
  }
  // Source entrypoints and authentication proofs retain current-source gates.
  assertDeployment(config, proof);
}
