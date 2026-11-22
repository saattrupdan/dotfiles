import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { expect, webkit } from "@playwright/test";

const id = "c2d90aba-4820-494b-978d-1991e3e820cf";
const unseen = "d2d90aba-4820-494b-978d-1991e3e820cf";
const key = (n: number) => n.toString(16).padStart(64, "0");
const messages = [
  { role: "user", content: "Offline question", remoteHistoryKey: key(1) },
  {
    role: "assistant",
    remoteHistoryKey: key(2),
    content: [
      { type: "thinking", thinking: "Offline reasoning" },
      {
        type: "text",
        text:
          "Offline answer. " +
          "Readable paragraph.\n\n".repeat(90) +
          "![secret](data:image/png;base64,SECRET_IMAGE_PAYLOAD)",
      },
      { type: "image", data: "SECRET_IMAGE_PAYLOAD", mimeType: "image/png" },
      {
        type: "toolCall",
        id: "tool-1",
        name: "read",
        arguments: { path: "report.txt", image: "SECRET_IMAGE_PAYLOAD" },
        toolDisplay: "read\nreport.txt",
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "read",
    toolDisplay: "read\nOffline tool output",
    content: "Offline tool output",
    remoteHistoryKey: key(3),
  },
];
const summary = (sessionId = id) => ({
  sessionId,
  name: sessionId === id ? "Cached conversation" : "Unopened conversation",
  cwd: "/fixture",
  lastActivity: sessionId === id ? 2000 : 1000,
});

test(
  "persistent offline reading",
  { skip: process.env.PI_REMOTE_BROWSER_PROOF !== "1", timeout: 90000 },
  async (t) => {
    const entry = "/__offline-fixture.ts";
    const server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL("..", import.meta.url)),
      logLevel: "error",
      plugins: [
        vue(),
        {
          name: "offline-fixture",
          resolveId: (source) => (source === entry ? entry : undefined),
          load: (source) =>
            source !== entry
              ? undefined
              : `
        import { createApp } from 'vue';
        import { createPinia } from 'pinia';
        import { createRouter, createMemoryHistory } from 'vue-router';
        import App from '/src/frontend/App.vue';
        import Conversation from '/src/frontend/views/Conversation.vue';
        import Sessions from '/src/frontend/views/Sessions.vue';
        import Settings from '/src/frontend/views/Settings.vue';
        import NewSession from '/src/frontend/views/NewSession.vue';
        import '/src/frontend/assets/main.css';
        const router = createRouter({history: createMemoryHistory(), routes: [
          {path:'/', component: Sessions}, {path:'/session/:id',component:Conversation},
          {path:'/settings',component:Settings}, {path:'/new',component:NewSession}
        ]});
        await router.push(new URL(location.href).searchParams.get('route') || '/');
        await router.isReady();
        createApp(App).use(createPinia()).use(router).mount('#app');
      `,
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (!req.url?.startsWith("/?") && req.url !== "/") return next();
              res.setHeader("Content-Type", "text/html");
              res.end(
                `<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="${entry}"></script>`,
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await webkit.launch();
    try {
      for (const mode of ["offline", "stalled"] as const) {
        await t.test(
          `reopen ${mode}, read unopened history, clear without writes`,
          async () => {
            const context = await browser.newContext({
              viewport: { width: 402, height: 874 },
            });
            let state: "online" | "offline" | "stalled" = "online";
            const mutations: string[] = [];
            await context.routeWebSocket("**/api/v1/events", () => {});
            await context.route("**/api/v1/**", async (route) => {
              const url = new URL(route.request().url());
              if (state === "offline") return route.abort("failed");
              if (state === "stalled") return;
              if (
                route.request().method() !== "GET" &&
                !url.pathname.includes("/auth/")
              )
                mutations.push(url.pathname);
              let body: unknown = {};
              if (url.pathname.endsWith("/me"))
                body = { paired: true, csrf: "fixture" };
              else if (url.pathname.endsWith("/offline-catalog"))
                body = { sessions: [summary(), summary(unseen)], removed: [] };
              else if (url.pathname.endsWith("/history"))
                body = { messages, older: null, revision: "fixture", total: 3 };
              else if (url.pathname === "/api/v1/sessions")
                body = [{ ...summary(), state: "idle", epoch: 1, sequence: 0 }];
              else if (url.pathname === "/api/v1/session-folders") body = [];
              else if (url.pathname.startsWith("/api/v1/sessions/"))
                body = {
                  ...summary(url.pathname.split("/")[4]),
                  state: "idle",
                  epoch: 1,
                  sequence: 0,
                };
              else if (url.pathname === "/api/v1/devices") body = [];
              else if (url.pathname === "/api/v1/auth/unlock")
                body = { unlocked: true };
              await route.fulfill({ json: body });
            });
            let page = await context.newPage();
            await page.goto(origin);
            await page.getByRole("link", { name: "Settings", exact: true }).click();
            await expect(
              page.getByText("2 conversations saved for offline reading."),
            ).toBeVisible();
            const persistence = await page.evaluate(`(async () => {
              const { OfflineLibrary } = await import('/src/frontend/lib/offline-library.ts');
              const library = new OfflineLibrary('offline-public-contract');
              const initial = await library.read();
              await library.save({sessionId:'test',cwd:'/fixture',lastActivity:1}, [{
                role:'user', content:[{type:'image',data:'PRIVATE_IMAGE_BYTES'},{type:'text',text:'Readable saved text'}],
                csrf:'PRIVATE_CREDENTIAL'
              }], initial.epoch);
              const saved = await new OfflineLibrary('offline-public-contract').read();
              await library.clear();
              await library.save({sessionId:'late',cwd:'/fixture',lastActivity:2}, [{role:'user',content:'Late response'}], initial.epoch);
              return { saved: JSON.stringify(saved), afterClear: (await library.read()).copies.length };
            })()`);
            assert(persistence.saved.includes("Readable saved text"));
            assert(!persistence.saved.includes("PRIVATE_IMAGE_BYTES"));
            assert(!persistence.saved.includes("PRIVATE_CREDENTIAL"));
            assert.equal(persistence.afterClear, 0);
            await page.close();
            state = mode;
            page = await context.newPage();
            const started = Date.now();
            await page.goto(origin);
            await expect(
              page.getByRole("heading", { name: "Saved conversations" }),
            ).toBeVisible({ timeout: 6500 });
            assert(Date.now() - started < 6500);
            await expect(
              page.getByRole("button", { name: "New conversation", exact: true }),
            ).toBeDisabled();
            await page.getByRole("link", { name: "Unopened conversation" }).click();
            await expect(
              page.getByRole("heading", { name: "Unopened conversation" }),
            ).toBeVisible();
            await expect(
              page.getByText("Offline answer", { exact: false }),
            ).toBeVisible();
            await expect(
              page.getByText("[Image unavailable offline]", { exact: true }).first(),
            ).toBeVisible();
            await expect(page.locator(".offline-reader img")).toHaveCount(0);
            await expect(
              page.getByRole("textbox", { name: "Message", exact: true }),
            ).toBeDisabled();
            await expect(
              page.getByRole("button", { name: "Send", exact: true }),
            ).toBeDisabled();
            await page.getByRole("button", { name: "Reasoning", exact: true }).click();
            await expect(
              page.getByText("Offline reasoning", { exact: true }),
            ).toBeVisible();
            await page
              .getByRole("button", { name: "Tool outputs", exact: true })
              .click();
            await expect(
              page.getByText("Offline tool output", { exact: false }).first(),
            ).toBeVisible();
            assert.deepEqual(mutations, []);
            if (mode === "offline") {
              await page.evaluate(async () => {
                window.scrollTo({ top: 300, behavior: "instant" });
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                );
              });
              const anchor = await page
                .locator("[data-history-row]")
                .nth(1)
                .evaluate((el) => ({
                  key: (el as HTMLElement).dataset.historyRow!,
                  top: el.getBoundingClientRect().top,
                }));
              state = "online";
              await page.evaluate(() => window.dispatchEvent(new Event("online")));
              await expect(
                page.getByRole("textbox", { name: "Message Pi", exact: true }),
              ).toBeEnabled();
              await expect
                .poll(() =>
                  page
                    .locator(`[data-history-row="${anchor.key}"]`)
                    .evaluate(
                      (el, top) => Math.abs(el.getBoundingClientRect().top - top),
                      anchor.top,
                    ),
                )
                .toBeLessThan(4);
              state = "offline";
              await page.reload();
              await expect(page.locator(".offline-reader")).toBeVisible();
            }
            await page.getByRole("link", { name: "Settings", exact: true }).click();
            await page
              .getByRole("button", { name: "Clear all offline conversations" })
              .click();
            await expect(
              page.getByText("0 conversations saved on this phone."),
            ).toBeVisible();
            await page.reload();
            await expect(
              page.getByText("No conversations saved on this phone.", { exact: false }),
            ).toBeVisible({ timeout: 6500 });
            await context.close();
          },
        );
      }
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
