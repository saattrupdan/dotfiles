import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { expect, webkit, type WebSocketRoute } from "@playwright/test";

const id = "c2d90aba-4820-494b-978d-1991e3e820cf";
const entry = "/__conversation-fixture.ts";
const bootstrap = `
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import App from '/src/frontend/App.vue';
import Conversation from '/src/frontend/views/Conversation.vue';
import Sessions from '/src/frontend/views/Sessions.vue';
import Settings from '/src/frontend/views/Settings.vue';
import NewSession from '/src/frontend/views/NewSession.vue';
import { useAuth } from '/src/frontend/stores/auth.ts';
import '/src/frontend/assets/main.css';
const pinia = createPinia();
const auth = useAuth(pinia);
auth.initialize = async () => {};
auth.unlocked = true;
auth.visible = true;
const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: '/session/:id', component: Conversation },
  { path: '/', component: Sessions },
  { path: '/settings', component: Settings },
  { path: '/new', component: NewSession },
] });
await router.push('/session/${id}');
await router.isReady();
createApp(App).use(pinia).use(router).mount('#app');
`;

test(
  "phone question controls remain reachable beside a long transcript",
  { skip: process.env.PI_REMOTE_BROWSER_PROOF !== "1", timeout: 60000 },
  async (t) => {
    // This frontend-only fixture never connects to a broker or a real profile.
    const server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL("..", import.meta.url)),
      logLevel: "error",
      plugins: [
        vue(),
        {
          name: "conversation-layout-fixture",
          resolveId(source) {
            if (source === entry) return entry;
          },
          load(source) {
            if (source === entry) return bootstrap;
          },
          configureServer(vite) {
            vite.middlewares.use((request, response, next) => {
              if (request.url !== "/") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                `<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="${entry}"></script>`,
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0 },
    });
    let browser: Awaited<ReturnType<typeof webkit.launch>> | undefined;
    try {
      await server.listen();
      const address = server.httpServer!.address();
      assert(address && typeof address !== "string");
      browser = await webkit.launch();
      const page = await browser.newPage({
        viewport: { width: 402, height: 874 },
        isMobile: true,
        hasTouch: true,
      });
      let socket: WebSocketRoute | undefined;
      let prompt: Record<string, unknown> | undefined;
      const submissions: Array<Record<string, unknown>> = [];
      const folderRequests: string[] = [];
      const session = () => ({
        sessionId: id,
        name: "Phone layout fixture",
        cwd: "/fixture",
        epoch: 1,
        sequence: 0,
        lastActivity: 1000,
        state: prompt ? "waiting" : "idle",
        prompt,
      });
      await page.routeWebSocket("**/api/v1/events", (route) => {
        socket = route;
      });
      await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        let body: unknown = {};
        if (url.pathname === "/api/v1/sessions") {
          if (url.searchParams.has("folder"))
            folderRequests.push(url.searchParams.get("folder")!);
          body = [session()];
        } else if (url.pathname === `/api/v1/sessions/${id}`) body = session();
        else if (url.pathname === "/api/v1/session-folders")
          body = [{ cwd: "/fixture", count: 1, lastActivity: 1000 }];
        else if (
          url.pathname === "/api/v1/devices" ||
          url.pathname === "/api/v1/favorites"
        )
          body = [];
        else if (url.pathname === "/api/v1/directories")
          body = {
            path: "/Users/you",
            parent: "/Users",
            directories: [{ name: "Projects", path: "/Users/you/Projects" }],
          };
        else if (url.pathname.endsWith("/history"))
          body = {
            messages: [
              ...Array.from({ length: 35 }, (_, index) => ({
                role: index % 2 ? "assistant" : "user",
                content: `Transcript message ${index}. `.repeat(12),
                timestamp: index,
              })),
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Describe the attached image.\n[Image: original 3024x4032, displayed at 1500x2000. Multiply coordinates by 2.02 to map to original image.]",
                  },
                  {
                    type: "image",
                    mimeType: "image/png",
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                  },
                ],
                timestamp: 36,
              },
            ],
            next: null,
          };
        else if (url.pathname.endsWith("/actions")) {
          submissions.push(route.request().postDataJSON().command);
          body = { status: "persisted" };
        }
        await route.fulfill({ json: body });
      });
      await page.addInitScript({
        content: `window.__scrollModes=[];const originalScroll=window.scrollTo.bind(window);window.scrollTo=(...args)=>{if(typeof args[0]==="object")window.__scrollModes.push(args[0].behavior);originalScroll(...args);};`,
      });
      await page.clock.setFixedTime(1000);
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await expect(page.getByRole("heading", { name: session().name })).toBeVisible();
      await expect.poll(() => Boolean(socket)).toBe(true);
      await t.test(
        "image and message render without internal sizing text",
        async () => {
          await expect(page.getByAltText("Conversation image")).toHaveCount(1);
          await expect(
            page.getByText("Describe the attached image.", { exact: true }),
          ).toBeVisible();
          await expect(page.getByText(/\[Image: original 3024x4032/)).toHaveCount(0);
        },
      );
      await t.test(
        "opening and incoming messages smoothly follow the bottom",
        async () => {
          const gap = () =>
            page.evaluate(
              () =>
                document.documentElement.scrollHeight -
                window.scrollY -
                window.innerHeight,
            );
          await expect.poll(gap).toBeLessThan(3);
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          socket!.send(
            JSON.stringify({
              version: 1,
              sessionId: id,
              type: "message_end",
              data: {
                role: "assistant",
                timestamp: 1001,
                content: "New message. ".repeat(300),
              },
            }),
          );
          await expect.poll(gap).toBeLessThan(3);
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          socket!.send(
            JSON.stringify({
              version: 1,
              sessionId: id,
              type: "message_update",
              data: {
                role: "assistant",
                timestamp: 1002,
                content: "Streaming message. ".repeat(500),
              },
            }),
          );
          await expect.poll(gap).toBeLessThan(3);
          assert(
            await page.evaluate(
              "window.__scrollModes.filter(mode=>mode==='smooth').length >= 3",
            ),
          );
        },
      );
      const publish = async (next: typeof prompt) => {
        prompt = next;
        socket!.send(
          JSON.stringify({
            version: 1,
            sessionId: id,
            sequence: 1,
            type: "prompt",
            data: next ?? null,
          }),
        );
      };
      await page.getByRole("textbox", { name: "Message Pi" }).fill("Keep this draft");
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const question = {
        id: "question-one",
        title: "Choose blue or green.",
        options: ["blue", "green"],
        deadline: 1801000,
        state: "pending",
      };
      await publish(question);
      await t.test(
        "an arriving question is actionable without scrolling up",
        async () => {
          const green = page.getByRole("button", { name: "green", exact: true });
          await expect(green).toBeInViewport({ ratio: 1 });
          assert.equal(submissions.length, 0);
          await green.click();
          await expect.poll(() => submissions.length).toBe(1);
          assert.deepEqual(submissions[0], {
            action: "answer",
            promptId: question.id,
            answer: "green",
          });
          await publish(undefined);
          await expect(green).toHaveCount(0);
          await expect(page.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
            "Keep this draft",
          );
        },
      );
      await t.test(
        "choices remain reachable with a reduced keyboard viewport",
        async () => {
          await page.setViewportSize({ width: 402, height: 480 });
          await publish({ ...question, id: "question-two" });
          await expect(
            page.getByRole("button", { name: "green", exact: true }),
          ).toBeInViewport({ ratio: 1 });
        },
      );
      await t.test(
        "Enter answers the question without sending the saved draft",
        async () => {
          await page.getByRole("textbox", { name: "Answer Pi" }).fill("violet");
          await page.getByRole("textbox", { name: "Answer Pi" }).press("Enter");
          await expect.poll(() => submissions.length).toBe(2);
          assert.deepEqual(submissions[1], {
            action: "answer",
            promptId: "question-two",
            answer: "violet",
          });
          await page.getByRole("textbox", { name: "Answer Pi" }).fill("Old answer");
          await publish({ ...question, id: "question-three" });
          await expect(page.getByRole("textbox", { name: "Answer Pi" })).toHaveValue(
            "",
          );
          await expect(
            page.getByRole("button", { name: "Answer", exact: true }),
          ).toBeDisabled();
          assert.equal(submissions.length, 2);
        },
      );
      await t.test(
        "long multi-select questions scroll within the bottom panel",
        async () => {
          await publish({
            ...question,
            id: "question-four",
            multiSelect: true,
            options: Array.from({ length: 40 }, (_, index) => `Choice ${index}`),
          });
          const submit = page.getByRole("button", { name: "Submit selections" });
          await expect(submit).toBeDisabled();
          const panel = page.locator(".composer");
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  document.documentElement.scrollHeight -
                  window.scrollY -
                  window.innerHeight,
              ),
            )
            .toBeLessThan(3);
          const beforeScroll = await panel.evaluate((element) => ({
            documentY: window.scrollY,
            height: element.clientHeight,
            contentHeight: element.scrollHeight,
          }));
          assert(beforeScroll.contentHeight > beforeScroll.height);
          await page.getByRole("checkbox", { name: "Choice 39", exact: true }).check();
          await submit.click();
          const afterScroll = await panel.evaluate((element) => ({
            documentY: window.scrollY,
            panelY: element.scrollTop,
          }));
          assert(afterScroll.panelY > 0);
          assert.equal(afterScroll.documentY, beforeScroll.documentY);
          await expect.poll(() => submissions.length).toBe(3);
          assert.deepEqual(submissions[2], {
            action: "answer",
            promptId: "question-four",
            answer: ["Choice 39"],
          });
          await publish({ ...question, id: "question-five", multiSelect: true });
          await expect(submit).toBeDisabled();
          await expect(
            page.getByRole("checkbox", { name: "green", exact: true }),
          ).not.toBeChecked();
          await publish(undefined);
          await expect(page.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
            "Keep this draft",
          );
          assert.equal(
            submissions.some((command) => command.action === "message"),
            false,
          );
        },
      );
      await t.test(
        "collapsing receipts never hides existing or subsequent delivery failures",
        async () => {
          const receipts = page.getByText("Delivery", { exact: true });
          await receipts.click();
          socket!.send(
            JSON.stringify({
              version: 1,
              sessionId: id,
              sequence: 2,
              type: "command.status",
              data: { id: "fixture-rejected", status: "rejected" },
            }),
          );
          await expect(
            page.getByRole("status").filter({ hasText: "rejected" }),
          ).toBeVisible();
          await receipts.click();
          socket!.send(
            JSON.stringify({
              version: 1,
              sessionId: id,
              sequence: 3,
              type: "command.status",
              data: { id: "fixture-unknown", status: "delivery_unknown" },
            }),
          );
          await expect(
            page.getByRole("status").filter({ hasText: "rejected" }),
          ).toBeVisible();
          await expect(page.getByText(/retrying may duplicate work/)).toBeVisible();
          await expect(page.locator(".delivery details")).not.toHaveAttribute(
            "open",
            "",
          );
          assert.equal(submissions.length, 3);
        },
      );
      await t.test(
        "minimal navigation keeps the cog accessible and mobile screens usable",
        async () => {
          await page.setViewportSize({ width: 402, height: 874 });
          await page.evaluate(() => window.scrollTo(0, 0));
          const settings = page.getByRole("link", { name: "Settings", exact: true });
          await expect(settings.locator("svg")).toHaveCount(1);
          await expect(settings).toHaveText("");
          const bounds = await settings.boundingBox();
          assert(bounds && bounds.width >= 44 && bounds.height >= 44);
          const screenshots = process.env.PI_REMOTE_VISUAL_PROOF_DIR;
          if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
          await settings.click();
          await expect(
            page.getByRole("heading", { name: "Settings", exact: true }),
          ).toBeVisible();
          if (screenshots)
            await page.screenshot({
              path: path.join(screenshots, "settings.png"),
              fullPage: true,
            });
          await page.getByRole("link", { name: "Pi Remote", exact: true }).click();
          await expect(
            page.getByRole("heading", { name: "Conversations", exact: true }),
          ).toBeVisible();
          assert.equal(folderRequests.length, 0);
          await page.locator("button.folder").click();
          await expect(
            page.getByRole("link", { name: /Phone layout fixture/ }),
          ).toBeVisible();
          assert(folderRequests.every((folder) => folder === "/fixture"));
          assert(folderRequests.length > 0);
          if (screenshots)
            await page.screenshot({
              path: path.join(screenshots, "conversations.png"),
              fullPage: true,
            });
          await page
            .getByRole("link", { name: "New conversation", exact: true })
            .click();
          await expect(
            page.getByRole("heading", { name: "Choose a folder", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Start here", exact: true }),
          ).toBeEnabled();
          if (screenshots)
            await page.screenshot({
              path: path.join(screenshots, "folder.png"),
              fullPage: true,
            });
          await settings.click();
          await page.getByRole("button", { name: "Lock", exact: true }).click();
          await expect(
            page.getByRole("button", { name: "Unlock with passkey", exact: true }),
          ).toBeVisible();
          await expect(settings).toHaveCount(0);
          if (screenshots)
            await page.screenshot({
              path: path.join(screenshots, "unlock.png"),
              fullPage: true,
            });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
            true,
          );
        },
      );
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
