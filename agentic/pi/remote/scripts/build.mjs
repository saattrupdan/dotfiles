import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
await build({
  entryPoints: {
    broker: path.join(root, "packages/broker/src/main.ts"),
    "run-managed": path.join(root, "packages/broker/src/run-managed.ts"),
    cli: path.join(root, "packages/cli/src/index.ts"),
  },
  outdir: dist,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node24",
  sourcemap: true,
});
const web = path.join(root, "packages/web/dist");
const assets = fs
  .readdirSync(path.join(web, "assets"))
  .filter((name) => /\.(js|css)$/.test(name))
  .sort()
  .map((name) => `/assets/${name}`);
const worker = path.join(web, "sw.js");
const source = fs.readFileSync(worker, "utf8");
const fingerprint = createHash("sha256").update(source).update(JSON.stringify(assets));
for (const name of fs.readdirSync(web, { recursive: true }).sort()) {
  const file = path.join(web, name);
  if (fs.statSync(file).isFile())
    fingerprint.update(name).update(fs.readFileSync(file));
}
const version = fingerprint.digest("hex").slice(0, 16);
fs.writeFileSync(
  worker,
  source
    .replace(
      "const BUILD_ASSETS = [];",
      `const BUILD_ASSETS = ${JSON.stringify(assets)};`,
    )
    .replace("pi-remote-shell-v1", `pi-remote-shell-${version}`),
);
fs.cpSync(web, path.join(dist, "web"), {
  recursive: true,
});
