import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { ToolDisplay } from "../../broker/src/tool-display.ts";
import { expect, webkit, type WebSocketRoute, type Route } from "@playwright/test";

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
import { useSessions } from '/src/frontend/stores/sessions.ts';
import '/src/frontend/assets/main.css';
const pinia = createPinia();
const auth = useAuth(pinia);
window.__connectionAuth=auth;
window.__homeSessions=useSessions(pinia);
auth.initialize = async () => {};
auth.initializing = false;
auth.unlocked = true;
auth.paired = true;
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
      let extraFolders: unknown[] = [];
      let extraHistory: unknown[] = [];
      let historyGate: Promise<void> | undefined;
      let emptyHistory = false;
      let homeGate: Promise<void> | undefined;
      let emptyHomeListing = false;
      let pagedHistory = false;
      let olderGate: Promise<void> | undefined;
      let olderFetches = 0;
      const pagingRows = Array.from({ length: 60 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        content: `Paged message ${index}. ` + "Readable history text. ".repeat(35),
        timestamp: 2000 + index,
        remoteHistoryKey: index.toString(16).padStart(64, "0"),
      }));
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
        if (
          homeGate &&
          ["/api/v1/sessions", "/api/v1/session-folders"].includes(url.pathname)
        )
          await homeGate;
        if (url.pathname.endsWith("/history") && historyGate) await historyGate;
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
          body =
            emptyHomeListing && !url.searchParams.has("folder")
              ? []
              : [session(), ...extraSessions];
        } else if (url.pathname === `/api/v1/sessions/${id}`) body = session();
        else if (url.pathname === "/api/v1/session-folders")
          body = [
            { cwd: "/Users/fixture", count: 1, lastActivity: 1000 },
            ...extraFolders,
            { cwd: "/private/fixture", count: 1, lastActivity: 1000 },
            { cwd: "/tmp/fixture", count: 1, lastActivity: 1000 },
          ];
        else if (
          url.pathname === "/api/v1/devices" ||
          url.pathname === "/api/v1/favorites"
        )
          body = url.pathname.endsWith("/devices")
            ? [{ id: "fixture-phone", name: "Dan’s iPhone", created: 1000 }]
            : [];
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
        } else if (url.pathname.endsWith("/history") && emptyHistory)
          body = { messages: [] };
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
        if (pagedHistory && url.pathname.endsWith("/history")) {
          const before = url.searchParams.get("before");
          if (before) {
            olderFetches++;
            if (olderGate) await olderGate;
          }
          const end = before ? Number(before) : pagingRows.length;
          const start = Math.max(0, end - 10);
          const anchor = pagingRows.findIndex(
            (row) => row.remoteHistoryKey === url.searchParams.get("anchor"),
          );
          body = {
            messages: pagingRows.slice(start, end),
            revision: "paging-fixture",
            older: start ? String(start) : null,
            anchorFound: anchor >= 0,
            anchoredOlder: anchor > 0 ? String(anchor) : null,
          };
        }
        if (body && typeof body === "object" && "messages" in body)
          body.messages = await toolDisplay.messages(
            [...body.messages, ...extraHistory],
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

      await t.test(
        "running subagent previews show live native output and yield to final results",
        async () => {
          const call = {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "live-child",
                name: "subagent",
                arguments: {
                  agent: "builder",
                  taskName: "Fix tests",
                  task: "Fix the tests",
                },
              },
            ],
          };
          const projected = await toolDisplay.messages([call], "/Users/fixture", id);
          socket!.send(
            JSON.stringify({
              version: 1,
              sessionId: id,
              type: "message_end",
              data: projected[0],
            }),
          );
          const send = (type: string, data: unknown) =>
            socket!.send(JSON.stringify({ version: 1, sessionId: id, type, data }));
          const preview = (text: string) => ({
            toolCallId: "live-child",
            toolDisplay: `subagent Builder #2 [user]\n↳ $ npm test\n${text}`,
            toolDisplayStyles: ["plain", "plain", "plain"],
          });
          send("tool_progress_snapshot", [preview("Reading source fixture")]);
          await expect(
            page.getByText("Reading source fixture", { exact: true }),
          ).toBeVisible();
          send("tool_progress", preview("Fixing failing test fixture"));
          await expect(
            page.getByText("Fixing failing test fixture", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText("Reading source fixture", { exact: true }),
          ).toHaveCount(0);
          send("tool_progress", preview("<img src=x onerror=window.previewLeak=1>"));
          await expect(
            page.getByText("<img src=x onerror=window.previewLeak=1>", { exact: true }),
          ).toBeVisible();
          assert.equal(await page.evaluate("window.previewLeak"), undefined);
          const result = {
            role: "toolResult",
            toolCallId: "live-child",
            toolName: "subagent",
            content: [{ type: "text", text: "Child completed fixture" }],
            details: {
              agent: "builder",
              agentSource: "user",
              task: "Fix the tests",
              exitCode: 0,
              sessionLabel: "Builder #2",
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: "Child completed fixture" }],
                },
              ],
              usage: {
                input: 5,
                output: 3,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 1,
              },
            },
          };
          const final = await toolDisplay.messages([result], "/Users/fixture", id);
          send("message_end", final[0]);
          await expect(
            page.getByText("<img src=x onerror=window.previewLeak=1>", { exact: true }),
          ).toHaveCount(0);
          const completedLine = (final[0] as { toolDisplay: string }).toolDisplay
            .split("\n")
            .slice(1)
            .find((line) => line.includes("✓"));
          assert(completedLine);
          await expect(
            page.locator(".tool-preview").filter({ hasText: completedLine }),
          ).toBeVisible();
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
          // A browser restoring focus scroll is not a gesture to read older messages.
          await page.evaluate(() => {
            window.scrollTo({ top: window.scrollY - 185, behavior: "instant" });
            window.dispatchEvent(new Event("scroll"));
            window.dispatchEvent(new Event("resize"));
          });
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
      await t.test(
        "live working status matches laptop wording and clears when finished",
        async () => {
          for (const message of ["Thinking...", "Storing to memory…", "Bashing..."]) {
            socket!.send(
              JSON.stringify({
                version: 1,
                type: "working_status",
                sessionId: id,
                data: { message },
              }),
            );
            await expect(page.locator(".working-status")).toHaveText(message);
            await expect(page.locator(".working-status svg.spinning")).toHaveCount(1);
          }
          socket!.send(
            JSON.stringify({
              version: 1,
              type: "working_status",
              sessionId: id,
              data: { message: null },
            }),
          );
          await expect(page.locator(".working-status")).toHaveCount(0);
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
        for (const [index, name] of ["Untitled", " untitled ", "UNTITLED"].entries())
          extraSessions.push({
            ...session(),
            sessionId: `00000000-0000-4000-8000-00000000001${index}`,
            name,
          });
        await page.getByRole("link", { name: "Pi Remote", exact: true }).click();
        const active = page.getByRole("region", {
          name: "Active sessions",
          exact: true,
        });
        const folders = page.getByRole("region", { name: "Folders", exact: true });
        await expect(active.getByRole("link")).toHaveCount(5);
        const row = active.getByRole("link").first();
        await page.mouse.move(0, 0);
        const border = await row.evaluate(
          (el) => getComputedStyle(el).borderBottomColor,
        );
        await row.hover();
        const box = await row.boundingBox();
        assert(box);
        await page.mouse.down();
        await page.mouse.move(box.x + 30, box.y + 35);
        await page.mouse.up();
        assert.equal(
          await row.evaluate((el) => getComputedStyle(el).borderBottomColor),
          border,
          "Dragging list rows must not create a green border",
        );
        await expect(active.getByRole("link", { name: /untitled/i })).toHaveCount(0);
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
        "Home groups status before recency and alphabetizes folder names without case",
        async () => {
          extraSessions = [
            {
              ...session(),
              sessionId: "00000000-0000-4000-8000-000000000041",
              name: "Newest idle",
              state: "idle",
              lastActivity: 9000,
            },
            {
              ...session(),
              sessionId: "00000000-0000-4000-8000-000000000042",
              name: "Older running",
              state: "running",
              lastActivity: 1,
            },
            {
              ...session(),
              sessionId: "00000000-0000-4000-8000-000000000043",
              name: "Answer needed",
              state: "answer_needed",
              lastActivity: 8000,
            },
          ];
          extraFolders = [
            { cwd: "/Users/fixture/Zebra", count: 1, lastActivity: 2000 },
            { cwd: "/Users/fixture/apple", count: 1, lastActivity: 1 },
            { cwd: "/Users/fixture/Banana", count: 1, lastActivity: 3000 },
          ];
          await page.waitForLoadState("networkidle");
          await page.reload();
          await page.getByRole("link", { name: "Pi Remote", exact: true }).click();
          const active = page.getByRole("region", { name: "Active sessions" });
          await expect(active.locator("h3")).toHaveText([
            "Older running",
            "Answer needed",
            "Newest idle",
            "Phone layout fixture",
          ]);
          await expect(page.locator("button.folder h3")).toHaveText([
            "apple",
            "Banana",
            "fixture",
            "Zebra",
          ]);
          extraSessions = [];
          extraFolders = [];
          await page.waitForLoadState("networkidle");
          await page.reload();
          await page.getByRole("link", { name: "Pi Remote", exact: true }).click();
        },
      );
      await t.test(
        "opening a conversation shows an immediate spinner until the transcript is ready",
        async () => {
          let release!: () => void;
          historyGate = new Promise((resolve) => (release = resolve));
          try {
            await page
              .getByRole("region", { name: "Active sessions", exact: true })
              .getByRole("link", { name: /Phone layout fixture/ })
              .click();
            await expect(
              page.getByRole("status").filter({ hasText: "Opening conversation" }),
            ).toBeVisible();

            await expect(page.locator(".transcript")).toBeHidden();
            await expect
              .poll(() =>
                page
                  .locator(".composer")
                  .evaluate((el) =>
                    Math.abs(innerHeight - el.getBoundingClientRect().bottom),
                  ),
              )
              .toBeLessThan(3);
            await expect
              .poll(() =>
                page.evaluate(() => {
                  const spinner = document
                    .querySelector(".opening-indicator .loading-indicator")!
                    .getBoundingClientRect();
                  const header = document
                    .querySelector("header")!
                    .getBoundingClientRect();
                  const composer = document
                    .querySelector(".composer")!
                    .getBoundingClientRect();
                  return Math.abs(
                    spinner.top +
                      spinner.height / 2 -
                      (header.bottom + composer.top) / 2,
                  );
                }),
              )
              .toBeLessThan(3);
            const screenshots = process.env.PI_REMOTE_VISUAL_PROOF_DIR;
            if (screenshots)
              await page.screenshot({
                path: path.join(screenshots, "opening-conversation.png"),
              });
            release();
            await expect(
              page.getByRole("status").filter({ hasText: "Opening conversation" }),
            ).toHaveCount(0);
            await expect(
              page.getByRole("textbox", { name: "Message Pi" }),
            ).toBeVisible();
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
          } finally {
            release();
            historyGate = undefined;
          }
        },
      );

      await t.test(
        "empty conversations keep the composer at the bottom through resizing and multiline drafts",
        async () => {
          emptyHistory = true;
          try {
            await page.waitForLoadState("networkidle");
            await page.reload();
            await expect(page.locator(".opening-indicator")).toHaveCount(0);
            await expect
              .poll(() =>
                page
                  .locator(".composer")
                  .evaluate((el) =>
                    Math.abs(innerHeight - el.getBoundingClientRect().bottom),
                  ),
              )
              .toBeLessThan(3);
            await page.setViewportSize({ width: 402, height: 480 });
            await page
              .getByRole("textbox", { name: "Message Pi" })
              .fill("A multiline draft\n".repeat(10));
            await expect
              .poll(() =>
                page
                  .locator(".composer")
                  .evaluate((el) =>
                    Math.abs(innerHeight - el.getBoundingClientRect().bottom),
                  ),
              )
              .toBeLessThan(3);
            await page.getByRole("textbox", { name: "Message Pi" }).fill("");
          } finally {
            emptyHistory = false;
            await page.setViewportSize({ width: 402, height: 874 });
            await page.waitForLoadState("networkidle");
            await page.reload();
          }
        },
      );

      await t.test(
        "Home shows loading instead of empty claims until requests settle",
        async () => {
          await page.waitForLoadState("networkidle");
          let release!: () => void;
          const failListing = (route: Route) =>
            route.fulfill({ status: 503, json: { error: "session_list_unavailable" } });
          homeGate = new Promise((resolve) => (release = resolve));
          try {
            await page.evaluate(
              "window.__homeSessions.homeListing=[];window.__homeSessions.folders=[];window.__homeSessions.homeLoaded=true",
            );
            await page.getByRole("link", { name: "Pi Remote", exact: true }).click();
            const active = page.getByRole("region", {
              name: "Active sessions",
              exact: true,
            });
            await expect(
              active.getByRole("status").filter({ hasText: "Loading active sessions" }),
            ).toBeVisible();
            await expect(
              page.getByText("No active sessions", { exact: true }),
            ).toHaveCount(0);
            await expect(
              page.getByText("No conversations in the last 7 days", { exact: true }),
            ).toHaveCount(0);
            release();
            await expect(
              active.getByRole("link", { name: /Phone layout fixture/ }),
            ).toBeVisible();
            await expect(active.getByRole("status")).toHaveCount(0);
            await active.getByRole("link", { name: /Phone layout fixture/ }).click();
            emptyHomeListing = true;
            homeGate = new Promise((resolve) => (release = resolve));
            await page.evaluate("window.__homeSessions.homeListing=[]");
            await page.getByRole("link", { name: "Pi Remote", exact: true }).click();
            await expect(
              active.getByRole("status").filter({ hasText: "Loading active sessions" }),
            ).toBeVisible();
            await expect(
              page.getByText("No active sessions", { exact: true }),
            ).toHaveCount(0);
            release();
            await expect(
              page.getByText("No active sessions", { exact: true }),
            ).toBeVisible();
            homeGate = undefined;
            await page.getByRole("link", { name: "Settings", exact: true }).click();
            await page.route("**/api/v1/sessions", failListing);
            await page.getByRole("link", { name: "Pi Remote", exact: true }).click();
            await expect(page.getByRole("alert")).toHaveText(
              "session_list_unavailable",
            );
            await expect(
              page.getByText("No active sessions", { exact: true }),
            ).toHaveCount(0);
          } finally {
            await page.unroute("**/api/v1/sessions", failListing);
            release();
            homeGate = undefined;
            emptyHomeListing = false;
            await page.waitForLoadState("networkidle");
            await page.reload();
          }
        },
      );
      await t.test(
        "Home keeps its memory snapshot visible while refreshing after Back",
        async () => {
          await page.getByRole("link", { name: "Pi Remote", exact: true }).click();
          await expect(page.locator("button.folder")).toHaveCount(1);
          await page.locator("button.folder").click();
          await page.getByRole("link", { name: /Phone layout fixture/ }).click();
          await expect(page.locator(".opening-indicator")).toHaveCount(0);
          let release!: () => void;
          homeGate = new Promise((resolve) => (release = resolve));
          extraSessions = [
            {
              ...session(),
              sessionId: "00000000-0000-4000-8000-000000000033",
              name: "Fresh background fixture",
            },
          ];
          try {
            await page.getByRole("button", { name: "Go back", exact: true }).click();
            const active = page.getByRole("region", {
              name: "Active sessions",
              exact: true,
            });
            await expect(
              active.getByRole("link", { name: /Phone layout fixture/ }),
            ).toBeVisible();
            await expect(page.locator("button.folder")).toBeVisible();
            await expect(
              page.getByText("Loading conversations", { exact: true }),
            ).toHaveCount(0);
            await expect(
              active.getByRole("link", { name: /Fresh background fixture/ }),
            ).toHaveCount(0);
            release();
            await expect(
              active.getByRole("link", { name: /Fresh background fixture/ }),
            ).toBeVisible();
          } finally {
            release();
            homeGate = undefined;
            extraSessions = [];
            folderRequests.length = 0;
          }
        },
      );
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
        "history opens five turns and prefetches before the top without moving the reader",
        async () => {
          await publish(undefined);
          pagedHistory = true;
          olderFetches = 0;
          let release!: () => void;
          try {
            await page.waitForLoadState("networkidle");
            await page.reload();
            await expect(page.locator(".message")).toHaveCount(10);
            await expect(page.locator(".opening-indicator")).toHaveCount(0);
            assert.equal(olderFetches, 0);
            await page.evaluate(() => {
              const host = window as Window & {
                queuedFrames?: Map<number, () => void>;
                releaseFrames?: () => void;
              };
              const request = window.requestAnimationFrame.bind(window),
                cancel = window.cancelAnimationFrame.bind(window);
              const queued = new Map<number, () => void>();
              host.queuedFrames = queued;
              window.requestAnimationFrame = (callback) => {
                const frame = request((time) =>
                  queued.set(frame, () => callback(time)),
                );
                return frame;
              };
              window.cancelAnimationFrame = (frame) => {
                queued.delete(frame);
                cancel(frame);
              };
              host.releaseFrames = () => {
                window.requestAnimationFrame = request;
                window.cancelAnimationFrame = cancel;
                for (const callback of queued.values()) callback();
                queued.clear();
              };
            });
            socket!.send(
              JSON.stringify({
                version: 1,
                type: "working_status",
                sessionId: id,
                data: { message: "Thinking..." },
              }),
            );
            await expect
              .poll(() =>
                page.evaluate(
                  () =>
                    (window as Window & { queuedFrames?: Map<number, () => void> })
                      .queuedFrames?.size ?? 0,
                ),
              )
              .toBeGreaterThan(0);
            olderGate = new Promise((resolve) => (release = resolve));
            await page.evaluate(() => {
              window.dispatchEvent(new WheelEvent("wheel", { deltaY: -600 }));
              window.scrollTo({ top: 600, behavior: "instant" });
              (window as Window & { releaseFrames?: () => void }).releaseFrames?.();
            });
            await expect.poll(() => olderFetches).toBe(1);
            await expect(
              page.getByText("Loading earlier messages", { exact: true }),
            ).toHaveCount(1);
            assert(
              await page.evaluate(() => window.scrollY > 100),
              "Prefetch must start before the top",
            );
            socket!.send(
              JSON.stringify({
                version: 1,
                type: "message_end",
                sessionId: id,
                data: {
                  role: "assistant",
                  content: "Concurrent live message",
                  timestamp: 9000,
                },
              }),
            );
            await expect(
              page.getByText("Concurrent live message", { exact: true }),
            ).toHaveCount(1);
            const anchor = await page.evaluate(() =>
              [...document.querySelectorAll<HTMLElement>("[data-history-row]")]
                .map((el) => ({
                  key: el.dataset.historyRow!,
                  top: el.getBoundingClientRect().top,
                  bottom: el.getBoundingClientRect().bottom,
                }))
                .find((row) => row.bottom > 130 && row.top < innerHeight)!,
            );
            release();
            olderGate = undefined;
            await expect(page.locator(".message")).toHaveCount(21);
            const top = await page.evaluate(
              (key) =>
                [...document.querySelectorAll<HTMLElement>("[data-history-row]")]
                  .find((el) => el.dataset.historyRow === key)!
                  .getBoundingClientRect().top,
              anchor.key,
            );
            assert(
              Math.abs(top - anchor.top) < 3,
              `Reader moved ${top - anchor.top}px after prepend`,
            );
            assert.equal(olderFetches, 1);
            await page.evaluate(() => {
              (document.querySelector(".message") as HTMLElement).style.height =
                "1200px";
            });
            await expect
              .poll(async () =>
                Math.abs(
                  (await page.evaluate(
                    (key) =>
                      [...document.querySelectorAll<HTMLElement>("[data-history-row]")]
                        .find((el) => el.dataset.historyRow === key)!
                        .getBoundingClientRect().top,
                    anchor.key,
                  )) - anchor.top,
                ),
              )
              .toBeLessThan(3);
          } finally {
            release?.();
            olderGate = undefined;
            pagedHistory = false;
            await page.waitForLoadState("networkidle");
            await page.reload();
          }
        },
      );
      await t.test(
        "edit diffs retain native colours and every shell command line has one format",
        async () => {
          extraHistory = [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "styled-shell",
                  name: "bash",
                  arguments: { command: "printf first\n\nprintf second" },
                },
                {
                  type: "toolCall",
                  id: "styled-edit",
                  name: "edit",
                  arguments: { path: "styles.ts", oldText: "OLD", newText: "NEW" },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "styled-shell",
              toolName: "bash",
              content: [{ type: "text", text: "firstsecond" }],
            },
            {
              role: "toolResult",
              toolCallId: "styled-edit",
              toolName: "edit",
              content: [{ type: "text", text: "Edited" }],
              details: {
                diff: '-1 const OLD = "<img src=x onerror=alert(1)>";\n+1 const NEW = "safe";\n 2 unchanged',
              },
            },
          ];
          try {
            await page.reload();
            await expect(page.locator(".opening-indicator")).toHaveCount(0);
            const shell = page.locator(".tool-entry.shell");
            await expect(shell).toContainText("printf second");
            const styles = await shell
              .locator(".tool-name,.tool-line.command")
              .evaluateAll((elements) =>
                elements.map((element) => {
                  const css = getComputedStyle(element);
                  return {
                    font: css.fontFamily,
                    size: css.fontSize,
                    color: css.color,
                    whiteSpace: css.whiteSpace,
                  };
                }),
              );
            assert(styles.length >= 2);
            for (const style of styles) assert.deepEqual(style, styles[0]);
            await expect(page.locator(".tool-line.removed")).toHaveCSS(
              "color",
              "rgb(255, 181, 168)",
            );
            await expect(page.locator(".tool-line.added")).toHaveCSS(
              "color",
              "rgb(143, 219, 171)",
            );
            await expect(page.locator(".tool-entry.edit")).toContainText(
              "<img src=x onerror=alert(1)>",
            );
            await expect(page.locator(".tool-entry.edit img")).toHaveCount(0);
          } finally {
            extraHistory = [];
            await page.waitForLoadState("networkidle");
            await page.reload();
          }
        },
      );
      await t.test(
        "Back restores Home independently, anchors after refresh, and respects a new scroll",
        async () => {
          let release: (() => void) | undefined;
          extraSessions = Array.from({ length: 40 }, (_, index) => ({
            ...session(),
            sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            name: `Earlier session ${index}`,
            lastActivity: 2000 + index,
          }));
          extraFolders = Array.from({ length: 15 }, (_, index) => ({
            cwd: `/Users/more-${index}`,
            count: 1,
            lastActivity: 1000,
          }));
          const active = page
            .locator(".home .session")
            .filter({ hasText: session().name });
          try {
            await page.getByRole("link", { name: "Pi Remote", exact: true }).click();
            await expect(page.locator(".home .session")).toHaveCount(41);
            await active.evaluate((element) =>
              window.scrollTo({
                top: window.scrollY + element.getBoundingClientRect().top - 200,
                behavior: "instant",
              }),
            );
            const originalY = (await active.boundingBox())!.y;
            assert(originalY > 190 && originalY < 210);
            assert((await page.evaluate(() => window.scrollY)) > 1000);
            await active.click();
            await expect(page.locator(".opening-indicator")).toHaveCount(0);
            await expect
              .poll(() =>
                page.evaluate(
                  () =>
                    document.documentElement.scrollHeight -
                    window.innerHeight -
                    window.scrollY,
                ),
              )
              .toBeLessThan(3);
            homeGate = new Promise((resolve) => (release = resolve));
            await page.getByRole("button", { name: "Go back", exact: true }).click();
            await expect(active).toBeVisible();
            await expect
              .poll(async () => Math.abs((await active.boundingBox())!.y - originalY))
              .toBeLessThan(2);
            extraSessions.push({
              ...session(),
              sessionId: "00000000-0000-4000-8000-999999999999",
              name: "New top session",
              lastActivity: 5000,
              state: "running",
            });
            homeGate = undefined;
            release();
            await expect(page.locator(".home .session")).toHaveCount(42);
            await expect(page.locator("main > section")).toHaveAttribute(
              "aria-busy",
              "false",
            );
            await expect
              .poll(async () => Math.abs((await active.boundingBox())!.y - originalY))
              .toBeLessThan(2);
            await active.click();
            await expect(page.locator(".opening-indicator")).toHaveCount(0);
            homeGate = new Promise((resolve) => (release = resolve));
            await page.getByRole("button", { name: "Go back", exact: true }).click();
            await expect(active).toBeVisible();
            await page.evaluate(() => {
              window.dispatchEvent(new WheelEvent("wheel", { deltaY: -500 }));
              window.scrollTo({ top: 0, behavior: "instant" });
            });
            homeGate = undefined;
            release();
            await expect(page.locator("main > section")).toHaveAttribute(
              "aria-busy",
              "false",
            );
            await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
          } finally {
            homeGate = undefined;
            release?.();
            extraSessions = [];
            extraFolders = [];
            await page.waitForLoadState("networkidle");
            await page.reload();
          }
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
          await expect(page.getByText("Privacy", { exact: true })).toHaveCount(0);
          await expect(page.locator("details")).toHaveCount(0);
          await expect(
            page.getByRole("heading", { name: "Notifications", exact: true }),
          ).toBeVisible();
          await expect(page.getByText("Dan’s iPhone", { exact: true })).toBeVisible();
          const revokeBounds = await page
            .getByRole("button", { name: "Revoke", exact: true })
            .boundingBox();
          assert(revokeBounds && revokeBounds.height >= 44);
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
          await expect(page.locator("header .brand")).toHaveText("");
          assert.equal(
            await page
              .locator("header .brand")
              .evaluate((el) => getComputedStyle(el).paddingLeft),
            "4px",
          );
          await expect(page.locator("button.folder")).toHaveCount(1);
          await expect(page.getByText("/private/fixture", { exact: true })).toHaveCount(
            0,
          );
          await expect(page.getByText("/tmp/fixture", { exact: true })).toHaveCount(0);
          extraSessions = [
            {
              ...session(),
              sessionId: "00000000-0000-4000-8000-000000000022",
              name: "Untitled",
            },
          ];
          await page.locator("button.folder").click();
          await expect(page.getByRole("link", { name: /untitled/i })).toHaveCount(0);
          extraSessions = [];
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
          await page
            .getByRole("button", { name: "Close sessions", exact: true })
            .click();
          await expect(
            page.getByRole("button", { name: "Open sessions", exact: true }),
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

      await t.test(
        "notification opens its conversation from Home without losing a draft",
        async () => {
          await page.reload();
          await expect(page.getByRole("textbox", { name: "Message Pi" })).toBeVisible();
          await page
            .getByRole("textbox", { name: "Message Pi" })
            .fill("Draft saved before the notification");
          await page.getByRole("link", { name: "Pi Remote", exact: true }).click();
          await expect(
            page.getByRole("heading", { name: "Conversations", exact: true }),
          ).toBeVisible();
          await page.evaluate((sessionId) => {
            const channel = new MessageChannel();
            const received: unknown[] = [];
            Object.assign(window, {
              __notificationAcks: received,
              __notificationChannel: channel,
            });
            channel.port1.onmessage = (event) => received.push(event.data);
            navigator.serviceWorker.dispatchEvent(
              new MessageEvent("message", {
                origin: location.origin,
                source: channel.port2,
                data: {
                  type: "notification-open",
                  url: `/session/${sessionId}`,
                  id: 7,
                },
              }),
            );
          }, id);
          await expect(
            page.getByRole("heading", { name: session().name, exact: true }),
          ).toBeVisible();
          await expect(page.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
            "Draft saved before the notification",
          );
          await expect
            .poll(() => page.evaluate("window.__notificationAcks"))
            .toEqual([{ type: "notification-opened", id: 7 }]);
        },
      );
      await t.test(
        "brief connection failures stay quiet; sustained failures become actionable",
        async () => {
          await page.reload();
          await expect(
            page.getByRole("heading", { name: session().name }),
          ).toBeVisible();
          await page
            .getByRole("textbox", { name: "Message Pi" })
            .fill("Keep this draft through reconnects");
          await page.clock.install();
          const abort = (route: Route) => route.abort();
          await page.route("**/api/v1/**", abort);
          const failed = () =>
            page.evaluate(
              "window.__connectionAuth.online=false;window.__connectionAuth.connectionFailed=true",
            );
          const recovered = () =>
            page.evaluate(
              "window.__connectionAuth.online=true;window.__connectionAuth.connectionFailed=false",
            );
          const warning = page.getByRole("heading", {
            name: "Can't reach your Mac",
            exact: true,
          });
          await failed();
          await page.clock.fastForward(10000);
          await expect(warning).toHaveCount(0);
          await page.unroute("**/api/v1/**", abort);
          await recovered();
          await page.clock.fastForward(25000);
          await page.waitForLoadState("networkidle");
          await expect(warning).toHaveCount(0);
          await page.route("**/api/v1/**", abort);
          await failed();
          await page.clock.fastForward(20001);
          await expect(warning).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Try again", exact: true }),
          ).toBeVisible();
          await recovered();
          await expect(warning).toHaveCount(0);
          await expect(page.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
            "Keep this draft through reconnects",
          );
        },
      );
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
