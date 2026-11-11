import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webkit, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../../../dist/web/", import.meta.url));

test(
  "built public shell opens offline, retries safely and handles missing app modules",
  {
    skip: process.env.PI_REMOTE_BROWSER_PROOF !== "1",
    timeout: 60000,
  },
  async () => {
    assert(
      fs.existsSync(path.join(root, "index.html")),
      "Build the public shell before browser proofs",
    );
    let stallNavigation = false;
    const server = http.createServer((request, response) => {
      if (stallNavigation && request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.flushHeaders();
        return;
      }
      const file = path.join(
        root,
        new URL(request.url!, "http://fixture").pathname === "/"
          ? "index.html"
          : new URL(request.url!, "http://fixture").pathname.slice(1),
      );
      if (
        !file.startsWith(root) ||
        !fs.existsSync(file) ||
        !fs.statSync(file).isFile()
      ) {
        response.writeHead(404).end();
        return;
      }
      const type =
        (
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".webmanifest": "application/manifest+json",
          } as Record<string, string>
        )[path.extname(file)] || "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'",
      });
      response.end(fs.readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const browser = await webkit.launch();
    try {
      const context = await browser.newContext({
        viewport: { width: 402, height: 874 },
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      const calls: string[] = [];
      await page.route("**/api/v1/**", (route) => {
        calls.push(route.request().url());
        return route.fulfill({ json: { paired: false } });
      });
      await page.goto(url);
      await expect(page.getByText("Pair a device", { exact: true })).toBeVisible();
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await page.waitForLoadState("networkidle");
      stallNavigation = true;
      const started = Date.now();
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByText("Pair a device", { exact: true })).toBeVisible();
      assert(
        Date.now() - started < 8000,
        "Stalled HTML body must fall back to the cached shell",
      );
      stallNavigation = false;
      await context.setOffline(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Try again", exact: true }),
      ).toBeVisible();
      const alert = page.getByRole("alert");
      assert.equal(
        await alert.evaluate((element) => getComputedStyle(element).borderRadius),
        "24px",
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      const shots = process.env.PI_REMOTE_VISUAL_PROOF_DIR;
      if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, "offline.png") });
      }
      const cached = await page.evaluate(async () =>
        (
          await Promise.all(
            (await caches.keys()).map(async (key) =>
              (await (await caches.open(key)).keys()).map(
                (request) => new URL(request.url).pathname,
              ),
            ),
          )
        ).flat(),
      );
      assert(
        cached.includes("/") &&
          cached.includes("/startup.css") &&
          cached.includes("/startup.js"),
      );
      assert(
        cached.every(
          (file) => !file.startsWith("/api/") && !file.startsWith("/session/"),
        ),
      );
      const previous = calls.length;
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
      assert.equal(calls.length, previous);
      await context.setOffline(false);
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await expect(page.getByText("Pair a device", { exact: true })).toBeVisible();
      assert(
        calls.slice(previous).every((call) => call.endsWith("/me")),
        "Connection retry must not resend mutations",
      );
      await context.close();
      const paired = await browser.newContext({ serviceWorkers: "block" });
      const direct = await paired.newPage();
      const openingCalls: string[] = [];
      await direct.addInitScript(() => {
        Object.defineProperty(navigator, "credentials", {
          value: {
            get() {
              throw new Error("Unexpected biometric prompt");
            },
            create() {
              throw new Error("Unexpected passkey registration");
            },
          },
        });
      });
      await direct.routeWebSocket("**/api/v1/events", () => {});
      await direct.route("**/api/v1/**", (route) => {
        const pathname = new URL(route.request().url()).pathname;
        openingCalls.push(pathname);
        return route.fulfill({
          json: pathname.endsWith("/me")
            ? { paired: true, csrf: "fixture", device: "Paired phone" }
            : pathname.endsWith("/sessions") || pathname.endsWith("/session-folders")
              ? []
              : { unlocked: true },
        });
      });
      await direct.goto(url);
      await expect(
        direct.getByRole("heading", { name: "Conversations", exact: true }),
      ).toBeVisible();
      assert(openingCalls.includes("/api/v1/auth/unlock"));
      assert(!openingCalls.some((call) => /auth\/(options|assert)|pairing/.test(call)));
      await expect(direct.getByRole("button", { name: "Open sessions" })).toHaveCount(
        0,
      );
      await paired.close();
      const fallback = await browser.newContext({
        viewport: { width: 402, height: 874 },
        serviceWorkers: "block",
      });
      const cold = await fallback.newPage();
      await cold.route("**/assets/*.js", (route) => route.abort());
      await cold.goto(url);
      await expect(
        cold.getByRole("heading", { name: "Can't open Pi Remote" }),
      ).toBeVisible();
      await expect(cold.getByRole("button", { name: "Try again" })).toBeVisible();
      if (shots) await cold.screenshot({ path: path.join(shots, "startup-error.png") });
      await fallback.close();
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
