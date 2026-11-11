import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { ToolDisplay } from "../../broker/src/tool-display.ts";
import { expect, webkit, type WebSocketRoute } from "@playwright/test";

const id = "c2d90aba-4820-494b-978d-1991e3e820cf";
const entry = "/__conversation-fixture.ts";
const toolDisplay = new ToolDisplay(
  fileURLToPath(new URL("../../../../", import.meta.url)),
);
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
window.__paths = [];
router.afterEach(to => window.__paths.push(to.fullPath));
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
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      let socket: WebSocketRoute | undefined;
      let prompt: Record<string, unknown> | undefined;
      const submissions: Array<Record<string, unknown>> = [];
      const folderRequests: string[] = [];
      const commandIds: string[] = [];
      let actionStatus = "persisted";
      let extraSessions: unknown[] = [];
      let stopped = false,
        recoveries = 0,
        starts = 0;
      let createError = false;
      let native = false;
      let recoveryError = false;
      const deliveryOrder: string[] = [];
      const session = () => ({
        sessionId: id,
        nativeSessionId: native ? "nvim-phone-resume-fixture" : undefined,
        name: "Phone layout fixture",
        cwd: "/Users/fixture",
        epoch: stopped ? 0 : 1,
        sequence: 0,
        lastActivity: 1000,
        state: stopped ? "stopped" : prompt ? "waiting" : "idle",
        prompt,
      });
      await page.routeWebSocket("**/api/v1/events", (route) => {
        socket = route;
      });
      await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        let body: unknown = {};
        if (
          url.pathname === "/api/v1/sessions" &&
          route.request().method() === "POST"
        ) {
          starts++;
          if (createError) {
            await route.fulfill({
              status: 504,
              json: { error: "launch_timeout_check_mac" },
            });
            return;
          }
          body = session();
        } else if (url.pathname.endsWith("/recover")) {
          recoveries++;
          deliveryOrder.push("recover");
          if (recoveryError) {
            await route.fulfill({
              status: 504,
              json: { error: "launch_timeout_check_mac" },
            });
            return;
          }
          stopped = false;
          body = session();
        } else if (url.pathname === "/api/v1/sessions") {
          if (url.searchParams.has("folder"))
            folderRequests.push(url.searchParams.get("folder")!);
          body = url.searchParams.has("folder")
            ? [session()]
            : [session(), ...extraSessions];
        } else if (url.pathname === `/api/v1/sessions/${id}`) body = session();
        else if (url.pathname === "/api/v1/session-folders")
          body = [
            { cwd: "/Users/fixture", count: 1, lastActivity: 1000 },
            { cwd: "/private/fixture", count: 1, lastActivity: 1000 },
            { cwd: "/tmp/fixture", count: 1, lastActivity: 1000 },
          ];
        else if (
          url.pathname === "/api/v1/devices" ||
          url.pathname === "/api/v1/favorites"
        )
          body = [];
        else if (url.pathname === "/api/v1/directories") {
          const current = url.searchParams.get("path") || "/Users/you";
          body = {
            path: current,
            parent: current === "/Users/you" ? null : "/Users/you",
            directories:
              current === "/Users/you"
                ? [{ name: "Projects", path: "/Users/you/Projects" }]
                : current === "/Users/you/Projects"
                  ? [{ name: "Nested", path: "/Users/you/Projects/Nested" }]
                  : [],
          };
        } else if (url.pathname.endsWith("/history"))
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
              {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: "PRIVATE_REASONING_FIXTURE" },
                  {
                    type: "toolCall",
                    id: "memory1",
                    name: "store_memory",
                    arguments: { text: "FULL_TOOL_ARGUMENT" },
                  },
                ],
              },
              {
                role: "toolResult",
                toolCallId: "memory1",
                toolName: "store_memory",
                content: [
                  { type: "text", text: "Queued memory request 123; FULL_TOOL_OUTPUT" },
                ],
              },
              { role: "system", content: "HIDDEN_SYSTEM_NOTICE" },
              {
                role: "custom",
                customType: "internal",
                display: false,
                content: "HIDDEN_CUSTOM_NOTICE",
              },
              {
                role: "custom",
                customType: "remote:answer-needed",
                display: true,
                content: "Visible answer needed notice",
              },
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "skill1",
                    name: "skill",
                    arguments: { name: "diagnosing-bugs" },
                  },
                ],
              },
              {
                role: "toolResult",
                toolCallId: "skill1",
                toolName: "skill",
                details: { name: "diagnosing-bugs" },
                content: [{ type: "text", text: "## Private skill heading" }],
              },
            ],
            next: null,
          };
        else if (url.pathname.endsWith("/actions")) {
          deliveryOrder.push("send");
          submissions.push(route.request().postDataJSON().command);
          commandIds.push(route.request().postDataJSON().commandId);
          body = { status: actionStatus };
        }
        if (body && typeof body === "object" && "messages" in body)
          body.messages = await toolDisplay.messages(
            body.messages,
            "/Users/fixture",
            id,
          );
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
          await expect(page.getByText("HIDDEN_SYSTEM_NOTICE")).toHaveCount(0);
          await expect(page.getByText("HIDDEN_CUSTOM_NOTICE")).toHaveCount(0);
          await expect(page.getByText("Visible answer needed notice")).toBeVisible();
          await expect(page.getByAltText("Conversation image")).toHaveCount(1);
          await expect(
            page.getByText("Describe the attached image.", { exact: true }),
          ).toBeVisible();
          await expect(page.getByText(/\[Image: original 3024x4032/)).toHaveCount(0);
        },
      );
      await t.test(
        "opens at the bottom instantly; smooth follow never pulls a reader down",
        async () => {
          const gap = () =>
            page.evaluate(
              () =>
                document.documentElement.scrollHeight -
                window.scrollY -
                window.innerHeight,
            );
          await expect.poll(gap).toBeLessThan(3);
          assert.equal(
            await page.evaluate("window.__scrollModes.includes('smooth')"),
            false,
          );
          await page.evaluate("window.__scrollModes=[]");
          socket!.send(
            JSON.stringify({
              version: 1,
              sessionId: id,
              type: "message_end",
              data: {
                role: "assistant",
                timestamp: 1001,
                content: "New message. ".repeat(100),
              },
            }),
          );
          await expect
            .poll(() => page.evaluate("window.__scrollModes.includes('smooth')"))
            .toBe(true);
          await expect.poll(gap).toBeLessThan(3);
          await page.evaluate(() => {
            window.dispatchEvent(new Event("wheel"));
            window.scrollTo({ top: 0, behavior: "instant" });
          });
          await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
          await page.waitForTimeout(80);
          await page.evaluate("window.__scrollModes=[]");
          socket!.send(
            JSON.stringify({
              version: 1,
              sessionId: id,
              type: "message_update",
              data: {
                role: "assistant",
                timestamp: 1002,
                content: "Streaming message. ".repeat(300),
              },
            }),
          );
          await expect(page.getByText(/Streaming message/)).toBeAttached();
          await page.waitForTimeout(150);
          assert.equal(await page.evaluate(() => window.scrollY), 0);
          assert.equal(
            await page.evaluate("window.__scrollModes.includes('smooth')"),
            false,
          );
          await page.evaluate(() => {
            window.scrollTo({
              top: document.documentElement.scrollHeight,
              behavior: "instant",
            });
            window.dispatchEvent(new Event("scroll"));
          });
        },
      );
      await t.test(
        "tool summaries, global output toggles, sticky header and zoom guards",
        async () => {
          await expect(
            page.getByText("✓ Queued a memory", { exact: true }),
          ).toBeVisible();
          await expect(page.locator(".tool-entry details")).toHaveCount(0);
          await expect(
            page.getByText("FULL_TOOL_ARGUMENT", { exact: false }),
          ).toHaveCount(0);
          await page.getByRole("button", { name: "Expand tool outputs" }).click();
          await expect(page.getByText(/FULL_TOOL_ARGUMENT/)).toBeVisible();
          await page.getByRole("button", { name: "Expand reasoning" }).click();
          await expect(
            page.getByText("PRIVATE_REASONING_FIXTURE", { exact: true }),
          ).toBeVisible();
          await page.evaluate(() =>
            window.scrollTo({
              top: document.documentElement.scrollHeight,
              behavior: "instant",
            }),
          );
          assert((await page.locator("header").boundingBox())!.y >= 0);
          assert((await page.locator("header").boundingBox())!.y < 2);
          assert(
            await page.evaluate(
              () =>
                !document.dispatchEvent(
                  new Event("gesturestart", { cancelable: true }),
                ),
            ),
          );
          assert.equal(
            await page
              .getByRole("textbox", { name: "Message Pi" })
              .evaluate((e) => getComputedStyle(e).fontSize),
            "16px",
          );
        },
      );
      await t.test(
        "tool labels match the laptop skill renderer instead of raw markdown",
        async () => {
          await expect(
            page.locator(".tool-name").filter({ hasText: /^skill diagnosing-bugs$/ }),
          ).toBeVisible();
          await expect(
            page.getByText('✓ loaded skill "diagnosing-bugs"', { exact: true }),
          ).toBeVisible();
          await expect(
            page
              .locator(".tool-preview")
              .filter({ hasText: "## Private skill heading" }),
          ).toHaveCount(0);
          await page.getByRole("button", { name: "Collapse tool outputs" }).click();
          await page.getByRole("button", { name: "Collapse reasoning" }).click();
          if (process.env.PI_REMOTE_VISUAL_PROOF_DIR) {
            fs.mkdirSync(process.env.PI_REMOTE_VISUAL_PROOF_DIR, { recursive: true });
            await page.screenshot({
              path: path.join(process.env.PI_REMOTE_VISUAL_PROOF_DIR, "chat.png"),
            });
          }
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
        "delivery foldouts are absent and failures stay visible",
        async () => {
          await expect(page.getByText("Delivery", { exact: true })).toHaveCount(0);
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
          await expect(
            page.getByText(/another submission may duplicate work/),
          ).toBeVisible();
          await expect(page.locator(".delivery details")).toHaveCount(0);
          assert.equal(submissions.length, 3);
        },
      );
      await t.test(
        "a sent bubble gets a tick only after native persistence",
        async () => {
          actionStatus = "forwarded";
          await page
            .getByRole("textbox", { name: "Message Pi" })
            .fill("Native receipt fixture");
          await page.getByRole("button", { name: "Send message" }).click();
          await expect(page.locator(".outgoing-message")).toHaveCount(1);
          await expect(
            page.getByRole("status", { name: "Received by your laptop", exact: true }),
          ).toHaveCount(0);
          const commandId = commandIds.at(-1)!;
          socket!.send(
            JSON.stringify({
              version: 1,
              sessionId: id,
              type: "command.status",
              data: { id: commandId, status: "accepted_by_owner" },
            }),
          );
          socket!.send(
            JSON.stringify({
              version: 1,
              sessionId: id,
              type: "message_end",
              data: {
                role: "user",
                timestamp: 9900,
                content: `<!-- pi-remote-command:${commandId} -->\nNative receipt fixture`,
              },
            }),
          );
          await expect(
            page.locator(".message.user").filter({ hasText: "Native receipt fixture" }),
          ).toHaveCount(1);
          await expect(page.locator(".outgoing-message")).toHaveCount(0);
          await expect(
            page.getByRole("status", { name: "Received by your laptop", exact: true }),
          ).toHaveCount(0);
          socket!.send(
            JSON.stringify({
              version: 1,
              sessionId: id,
              type: "command.status",
              data: { id: commandId, status: "persisted" },
            }),
          );
          await expect(
            page.getByRole("status", { name: "Received by your laptop", exact: true }),
          ).toBeVisible();
          await expect(page.locator(".message.user .receipt svg")).toHaveCount(1);
          actionStatus = "persisted";
        },
      );
      await t.test("home separates active sessions from folder history", async () => {
        await page.setViewportSize({ width: 402, height: 874 });
        await publish(undefined);
        extraSessions = [
          "running",
          "idle",
          "waiting",
          "answer_needed",
          "stopped",
          "interrupted",
          "disconnected",
          "stopping",
        ].map((state, index) => ({
          ...session(),
          sessionId: `00000000-0000-4000-8000-00000000000${index}`,
          name: `Home ${state} fixture`,
          state,
        }));
        extraSessions.push({
          ...session(),
          sessionId: "00000000-0000-4000-8000-000000000009",
          name: "Private active fixture",
          cwd: "/private/fixture",
          state: "running",
        });
        await page.getByRole("link", { name: "Pi Remote", exact: true }).click();
        const active = page.getByRole("region", {
          name: "Active sessions",
          exact: true,
        });
        const folders = page.getByRole("region", { name: "Folders", exact: true });
        await expect(active.getByRole("link")).toHaveCount(5);
        for (const state of ["running", "idle", "waiting", "answer_needed"])
          await expect(
            active.getByRole("link", { name: new RegExp(`Home ${state} fixture`) }),
          ).toHaveCount(1);
        await expect(page.getByText("Private active fixture")).toHaveCount(0);
        await expect(folders.locator("button.folder")).toHaveCount(1);
        const top = await active.boundingBox(),
          bottom = await folders.boundingBox();
        assert(top && bottom && top.y < bottom.y);
        const search = page.getByRole("searchbox", {
          name: "Search sessions and folders",
        });
        await search.fill("running");
        await expect(active.getByRole("link")).toHaveCount(1);
        await expect(folders.locator("button.folder")).toHaveCount(0);
        await search.fill("");
        const screenshots = process.env.PI_REMOTE_VISUAL_PROOF_DIR;
        if (screenshots) {
          fs.mkdirSync(screenshots, { recursive: true });
          await page.screenshot({
            path: path.join(screenshots, "home-active-folders.png"),
            fullPage: true,
          });
        }
        extraSessions = [];
        stopped = true;
        socket!.send(
          JSON.stringify({ version: 1, type: "sessions.changed", data: null }),
        );
        await expect(active.getByRole("link")).toHaveCount(0);
        await expect(
          active.getByText("No active sessions", { exact: true }),
        ).toBeVisible();
        stopped = false;
        socket!.send(
          JSON.stringify({ version: 1, type: "sessions.changed", data: null }),
        );
        const live = active.getByRole("link", { name: /Phone layout fixture/ });
        await expect(live).toHaveCount(1);
        await live.click();
        await expect(page.getByRole("textbox", { name: "Message Pi" })).toBeVisible();
        await page.getByRole("button", { name: "Go back", exact: true }).click();
        await expect(
          page.getByRole("region", { name: "Active sessions", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("region", { name: "Folders", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Back to folders", exact: true }),
        ).toHaveCount(0);
        assert.equal(folderRequests.length, 0);
      });
      await t.test(
        "Send starts a stopped native conversation before dispatch and preserves failed drafts",
        async () => {
          await publish(undefined);
          native = true;
          stopped = true;
          recoveries = 0;
          deliveryOrder.length = 0;
          await page.goto(`http://127.0.0.1:${address.port}/`);
          const message = page.getByRole("textbox", { name: "Message Pi" });
          await message.fill("Resume my native conversation");
          await expect(
            page.getByRole("button", { name: "Send message" }),
          ).toBeEnabled();
          await page.getByRole("button", { name: "Send message" }).click();
          await expect
            .poll(
              () =>
                submissions.filter(
                  (command) => command.text === "Resume my native conversation",
                ).length,
            )
            .toBe(1);
          assert.deepEqual(deliveryOrder, ["recover", "send"]);
          assert.equal(recoveries, 1);
          stopped = true;
          recoveryError = true;
          deliveryOrder.length = 0;
          await page.waitForLoadState("networkidle");
          await page.reload();
          await message.fill("Keep my unsent draft");
          await page.getByRole("button", { name: "Send message" }).click();
          await expect(page.getByRole("alert")).toBeVisible();
          await expect(message).toHaveValue("Keep my unsent draft");
          assert.deepEqual(deliveryOrder, ["recover"]);
          assert.equal(
            submissions.filter((command) => command.text === "Keep my unsent draft")
              .length,
            0,
          );
          native = false;
          stopped = false;
          recoveryError = false;
          recoveries = 0;
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
          await expect(page.locator("button.folder")).toHaveCount(1);
          await expect(page.getByText("/private/fixture", { exact: true })).toHaveCount(
            0,
          );
          await expect(page.getByText("/tmp/fixture", { exact: true })).toHaveCount(0);
          await page.locator("button.folder").click();
          await expect(
            page.getByRole("link", { name: /Phone layout fixture/ }),
          ).toBeVisible();
          assert(folderRequests.every((folder) => folder === "/Users/fixture"));
          assert(folderRequests.length > 0);
          await page.getByRole("link", { name: "Pi Remote", exact: true }).click();
          await expect(page.locator("button.folder")).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Back to folders" }),
          ).toHaveCount(0);
          await page.locator("button.folder").click();
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
          await page.getByRole("button", { name: "Projects", exact: true }).click();
          await expect(
            page.getByRole("button", { name: "Nested", exact: true }),
          ).toBeVisible();
          await page.getByRole("button", { name: "Nested", exact: true }).click();
          await page.getByRole("button", { name: "Start here", exact: true }).click();
          await expect(
            page.getByRole("heading", { name: session().name }),
          ).toBeVisible();
          assert.equal(starts, 1);
          stopped = true;
          await page.waitForLoadState("networkidle");
          await page.reload();
          await expect(page.getByRole("button", { name: "Resume on Mac" })).toHaveCount(
            0,
          );
          await page
            .getByRole("textbox", { name: "Message Pi" })
            .fill("Resume and send once");
          await page.getByRole("button", { name: "Send message" }).click();
          await expect.poll(() => recoveries).toBe(1);
          await expect
            .poll(
              () =>
                submissions.filter((command) => command.text === "Resume and send once")
                  .length,
            )
            .toBe(1);
          await page.getByRole("button", { name: "Go back", exact: true }).click();
          await expect(
            page.getByRole("heading", { name: "Active sessions" }),
          ).toBeVisible();
          await expect(
            page.getByRole("heading", { name: "Folders", exact: true }),
          ).toBeVisible();
          await page.getByRole("link", { name: "New conversation" }).click();
          createError = true;
          await page.getByRole("button", { name: "Start here", exact: true }).click();
          await expect(page.getByRole("alert")).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Start here", exact: true }),
          ).toBeDisabled();
          assert.equal(starts, 2);
          assert.deepEqual(pageErrors, []);
          assert(
            (
              await page.evaluate(
                () => (window as unknown as { __paths: string[] }).__paths,
              )
            ).every(
              (path) =>
                !path.includes("?") &&
                !path.includes("fixture") &&
                !path.includes("Users"),
            ),
          );
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
