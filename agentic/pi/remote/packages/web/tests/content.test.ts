import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sharp = createRequire(new URL("../../broker/package.json", import.meta.url))(
  "sharp",
);

test("app and explicitly sized iPhone icons reproduce the native splash grid", async () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const touch = html.match(/<link[^>]*rel="apple-touch-icon"[^>]*>/)![0];
  assert.match(touch, /sizes="180x180"/);
  const touchPath = touch.match(/href="([^"]+)"/)![1]!;
  assert.notEqual(touchPath, "/icons/pi-192.png");
  assert(fs.readFileSync(path.join(root, "public/sw.js"), "utf8").includes(touchPath));
  const splash = fs.readFileSync(
    new URL("../../../../extensions/splash/index.ts", import.meta.url),
    "utf8",
  );
  const definition = splash.slice(
    splash.indexOf("const GRID"),
    splash.indexOf("const CELL_W"),
  );
  const grid = [...definition.matchAll(/\[[01, ]+\]/g)].map(
    (match) => JSON.parse(match[0]) as number[],
  );
  assert.equal(grid.length, 4);
  const icons = [
    [192, "/icons/pi-192.png"],
    [512, "/icons/pi-512.png"],
    [180, touchPath],
  ] as const;
  for (const [size, iconPath] of icons) {
    const { data, info } = await sharp(path.join(root, "public", iconPath.slice(1)))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.width, size);
    assert.equal(info.height, size);
    for (let row = 0; row < 4; row++)
      for (let col = 0; col < 4; col++) {
        const x = Math.floor(size * (0.25 + (col + 0.5) / 8));
        const y = Math.floor(size * (0.25 + (row + 0.5) / 8));
        const offset = (y * size + x) * 3;
        assert.deepEqual(
          [...data.subarray(offset, offset + 3)],
          grid[row]![col] ? [180, 228, 204] : [17, 23, 21],
        );
      }
  }
});

test("public icon content changes invalidate the built shell cache", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-cache-"));
  try {
    const web = path.join(fixture, "packages/web/dist");
    fs.mkdirSync(path.join(web, "assets"), { recursive: true });
    fs.mkdirSync(path.join(web, "icons"));
    fs.writeFileSync(path.join(web, "assets/app.js"), "same javascript");
    const script = path.join(fixture, "scripts/build.mjs");
    fs.mkdirSync(path.dirname(script));
    fs.copyFileSync(new URL("../../../scripts/build.mjs", import.meta.url), script);
    const dependency = path.join(fixture, "node_modules/esbuild");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({ type: "module", exports: "./index.js" }),
    );
    fs.writeFileSync(
      path.join(dependency, "index.js"),
      "export async function build() {}",
    );
    const worker = fs.readFileSync(path.join(root, "public/sw.js"), "utf8");
    const versions: string[] = [];
    for (const icon of ["first", "first", "changed icon"]) {
      fs.writeFileSync(path.join(web, "sw.js"), worker);
      fs.writeFileSync(path.join(web, "icons/pi-192.png"), icon);
      const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      versions.push(
        fs
          .readFileSync(path.join(fixture, "dist/web/sw.js"), "utf8")
          .match(/const CACHE = "([^"]+)"/)![1]!,
      );
    }
    assert.equal(versions[0], versions[1]);
    assert.notEqual(versions[1], versions[2]);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
test("service worker excludes APIs and content from its cache", () => {
  const sw = fs.readFileSync(path.join(root, "public/sw.js"), "utf8");
  assert(sw.includes('url.pathname.startsWith("/api/")'));
  assert(sw.includes("/assets"));
  assert(!sw.includes("transcript"));
});
test("phone stores do not persist sensitive state", () => {
  for (const name of ["auth", "sessions"]) {
    const text = fs.readFileSync(
      path.join(root, `src/frontend/stores/${name}.ts`),
      "utf8",
    );
    assert(!/localStorage|sessionStorage|indexedDB/.test(text));
  }
  const auth = fs.readFileSync(path.join(root, "src/frontend/stores/auth.ts"), "utf8");
  assert(auth.includes("120000"));
  assert(auth.includes('window.addEventListener("pagehide"'));
});
