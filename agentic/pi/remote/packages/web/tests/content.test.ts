import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
