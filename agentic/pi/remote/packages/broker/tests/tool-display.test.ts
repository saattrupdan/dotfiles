import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { createBroker } from "../src/server.ts";
import { ConfigSchema } from "../src/config.ts";
import { digest } from "../src/store.ts";
import type { Session, StreamEvent } from "../../protocol/src/index.ts";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ToolDisplay } from "../src/tool-display.ts";

const agentDir = fileURLToPath(new URL("../../../../", import.meta.url));
const cwd = "/Users/fixture/project";
const result = (text: string, details?: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text", text }],
  details,
  isError,
});

test("phone replays shared laptop renderers, not the first line of raw tool output", async () => {
  const display = new ToolDisplay(agentDir);
  const toolPresentation = async (
    name: string,
    args: object,
    output: ReturnType<typeof result>,
    id: string,
    cwd: string,
  ) => {
    const projected = (await display.messages(
      [
        {
          role: "assistant",
          content: [{ type: "toolCall", id, name, arguments: args }],
        },
        { role: "toolResult", toolCallId: id, toolName: name, ...output },
      ],
      cwd,
      "fixture",
    )) as Array<{ toolDisplay: string }>;
    return projected[1]!.toolDisplay;
  };
  const fixtures: Array<[string, object, ReturnType<typeof result>, string]> = [
    [
      "skill",
      { name: "diagnosing-bugs" },
      result("## PRIVATE_RAW_SKILL_HEADING", { name: "diagnosing-bugs" }),
      'skill diagnosing-bugs\n✓ loaded skill "diagnosing-bugs"',
    ],
    [
      "store_memory",
      { text: "PRIVATE_ARGUMENT" },
      result("Queued job 123"),
      "store_memory\n✓ Queued a memory",
    ],
    [
      "recall_memory",
      { text: "PRIVATE_ARGUMENT" },
      result("PRIVATE_RECALL_TEXT"),
      "recall_memory\n✓ Recalled a memory",
    ],
    [
      "search",
      { query: "target" },
      result("RAW_MATCHES", { collapsed: "3 results" }),
      "search target\n✓ 3 results",
    ],
    [
      "code_tree",
      { path: "src", depth: 2 },
      result("# tree src (3 files, depth 2)"),
      "code_tree src d=2\ncode_tree src ✓ 3 files",
    ],
    [
      "web_search",
      { query: "weather" },
      result("RAW_WEB_RESULTS", { status: "ok", resultCount: 2 }),
      "web_search weather\n✓ web search (2 results)",
    ],
    [
      "web_browse",
      { command: 'fill @e1 "PRIVATE_FORM_VALUE"' },
      result("RAW_BROWSER_OUTPUT"),
      "web_browse fill @e1 [text redacted]\n✓ Firefox action completed",
    ],
    [
      "generate_image",
      { prompt: "PRIVATE_PROMPT" },
      result("RAW_IMAGE_PATH", { count: 2 }),
      "generate_image\n✓ Generated 2 images",
    ],
    [
      "generate_video",
      { prompt: "PRIVATE_PROMPT" },
      result("RAW_VIDEO_PATH"),
      "generate_video\n✓ Generated video",
    ],
    [
      "bash",
      { command: "printf hello" },
      result("hello"),
      "$ printf hello\n✓ bash executed",
    ],
    [
      "codemode",
      { script: "PRIVATE_SCRIPT" },
      result("RAW_NESTED_RESULTS"),
      "codemode\n✓ codemode executed",
    ],
    [
      "subagent",
      { agent: "explorer", taskName: "Trace labels", task: "PRIVATE_TASK" },
      result("PRIVATE_AGENT_OUTPUT", {
        sessionLabel: "explorer2: Trace labels",
        exitCode: 0,
      }),
      "subagent explorer2: Trace labels [user]\n✓ All done",
    ],
  ];
  fixtures.push([
    "mcp",
    { action: "call" },
    result('{"results":[1,2]}'),
    "mcp\n✓ Found 2 results",
  ]);
  fixtures.push([
    "isolated_new_branch",
    { name: "feature/chat" },
    result("RAW_BRANCH_PATH"),
    "isolated_new_branch feature/chat\n✓ switched to new branch",
  ]);
  for (const [name, args, output, expected] of fixtures)
    assert.equal(
      await toolPresentation(name, args, output, "tool1", cwd),
      expected,
      name,
    );
  assert.equal(
    await toolPresentation(
      "read",
      { path: "file.ts" },
      result("PRIVATE_FILE_BODY"),
      "read1",
      cwd,
    ),
    "read file.ts",
  );
  assert.match(
    await toolPresentation(
      "skill",
      { name: "missing" },
      result('Skill "missing" not found.', undefined, true),
      "bad",
      cwd,
    ),
    /Skill "missing" not found/,
  );
  assert.match(
    await toolPresentation(
      "bash",
      { command: "false" },
      result("exit 1", undefined, true),
      "bad",
      cwd,
    ),
    /✗ bash failed/,
  );
});

test("history and streamed results use one renderer without changing original messages", async () => {
  const display = new ToolDisplay(agentDir);
  const messages = [
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
      ...result("## RAW_SKILL_HEADING", { name: "diagnosing-bugs" }),
    },
  ];
  const original = JSON.stringify(messages);
  const projected = (await display.messages(messages, cwd, "history1")) as Array<{
    toolDisplay?: string;
    content?: Array<{ toolDisplay?: string }>;
  }>;
  assert.equal(
    projected[1]?.toolDisplay,
    'skill diagnosing-bugs\n✓ loaded skill "diagnosing-bugs"',
  );
  assert.match(projected[0]?.content?.[0]?.toolDisplay ?? "", /^skill diagnosing-bugs/);
  assert.equal(JSON.stringify(messages), original);
  const events: StreamEvent[] = [];
  await new Promise<void>((resolve) => {
    for (const [type, data] of [
      ["message_end", messages[0]],
      ["message_end", messages[1]],
      ["command.status", { id: "receipt", status: "persisted" }],
    ] as const)
      display.emit(
        { version: 1, type, data, sessionId: "fixture" } as StreamEvent,
        cwd,
        (event) => {
          events.push(event);
          if (events.length === 3) resolve();
        },
        "stream1",
      );
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ["message_end", "message_end", "command.status"],
  );
  assert.equal(
    (events[1]?.data as { toolDisplay: string }).toolDisplay,
    projected[1]?.toolDisplay,
  );
});

test("oversized writes keep identifying arguments in completed and separately streamed rows", async () => {
  const display = new ToolDisplay(agentDir);
  const scope = "large-write";
  const original = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "large",
          name: "write",
          arguments: { content: "x".repeat(300000), path: "/fixture/important.ts" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "large",
      toolName: "write",
      ...result("Successfully wrote file"),
    },
  ];
  const before = JSON.stringify(original);
  const together = await display.messages(original, "/fixture", scope);
  const separately = await display.messages([original[1]], "/fixture", scope);
  for (const message of [together[1], separately[0]]) {
    const text = (message as { toolDisplay: string }).toolDisplay;
    assert.match(text, /important\.ts/);
    assert.match(text, /shortened; expand for full/);
  }
  assert.equal(JSON.stringify(original), before);
});

for (const lockDuringReplay of [false, true])
  test(
    `reconnect uses native displays in sequence and rechecks authorization (${lockDuringReplay})`,
    { timeout: 10000 },
    async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-replay-display-"));
      const origin = "https://fixture.test.ts.net";
      const broker = await createBroker(
        ConfigSchema.parse({ origin, dataDir: dir, home: dir, agentDir }),
        { ipc: false, history: false },
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let queued!: () => void;
      const replayQueued = new Promise<void>((resolve) => {
        queued = resolve;
      });
      let socket: WebSocket | undefined;
      const id = randomUUID(),
        device = randomUUID(),
        now = Date.now();
      const session: Session = {
        version: 1,
        instanceId: randomUUID(),
        sessionId: id,
        sessionFile: path.join(dir, "history.jsonl"),
        cwd: dir,
        name: "Fixture",
        pid: process.pid,
        managed: false,
        model: "fixture",
        thinking: "off",
        capabilities: [],
        idle: true,
        loop: false,
        epoch: 1,
        sequence: 0,
        state: "idle",
        lastActivity: now,
      };
      broker.store.save(session);
      broker.store.db
        .prepare("INSERT INTO devices VALUES (?,?,?,0,?)")
        .run(device, "Phone", "{}", now);
      broker.store.db
        .prepare("INSERT INTO auth VALUES (?,?,?,?,?,?,?,?)")
        .run(digest("cookie"), device, "csrf", now, now, null, now + 86400000, 1);
      const received: StreamEvent[] = [];
      const messages = ToolDisplay.prototype.messages;
      let first = true;
      t.mock.method(
        ToolDisplay.prototype,
        "messages",
        async function (this: ToolDisplay, ...args: Parameters<typeof messages>) {
          if (first) {
            first = false;
            await held;
          }
          return messages.apply(this, args);
        },
      );
      const emit = ToolDisplay.prototype.emit;
      let emissions = 0;
      t.mock.method(
        ToolDisplay.prototype,
        "emit",
        function (this: ToolDisplay, ...args: Parameters<typeof emit>) {
          emit.apply(this, args);
          if (++emissions >= 3) queued();
        },
      );
      try {
        const address = await broker.app.listen({ host: "127.0.0.1", port: 0 });
        socket = new WebSocket(address.replace("http:", "ws:") + "/api/v1/events", {
          headers: {
            host: new URL(origin).host,
            origin,
            cookie: "__Host-pi-remote=cookie",
          },
        });
        await once(socket, "open");
        socket.on("message", (raw) => received.push(JSON.parse(raw.toString())));
        broker.store.event(id, "message_end", {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "replayed",
              name: "skill",
              arguments: { name: "diagnosing-bugs" },
            },
          ],
        });
        const end = broker.store.event(id, "message_end", {
          role: "toolResult",
          toolCallId: "replayed",
          toolName: "skill",
          ...result("# Raw private heading", { name: "diagnosing-bugs" }),
        });
        // This already-queued live result must not overtake the replayed call.
        assert(end);
        broker.connections.emit(end);
        socket.send(
          JSON.stringify({ subscriptions: [{ sessionId: id, sequence: 0 }] }),
        );
        await replayQueued;
        if (lockDuringReplay)
          broker.store.db.prepare("UPDATE auth SET unlocked=0").run();
        const finished = lockDuringReplay
          ? once(socket, "close")
          : new Promise<void>((resolve) =>
              socket!.on("message", () => {
                if (received.length === 2) resolve();
              }),
            );
        release();
        await finished;
        if (lockDuringReplay) assert.deepEqual(received, []);
        else {
          assert.deepEqual(
            received.map((event) => event.sequence),
            [1, 2],
          );
          assert.match(JSON.stringify(received), /skill diagnosing-bugs/);
          assert.match(
            (received[1]!.data as { toolDisplay: string }).toolDisplay,
            /✓ loaded skill "diagnosing-bugs"/,
          );
          assert(
            !broker.store.db
              .prepare("SELECT data FROM events WHERE session=?")
              .all(id)
              .some((row) => String(row.data).includes("toolDisplay")),
          );
        }
      } finally {
        release();
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          const closed = once(socket, "close");
          socket.close();
          await closed;
        }
        await broker.app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

test("historical edit display never reads the current target for a preview", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-display-no-preview-"));
  const file = path.join(dir, "target.ts");
  fs.writeFileSync(file, "CURRENT PRIVATE FILE\n");
  let reads = 0;
  const original = fs.promises.readFile;
  t.mock.method(
    fs.promises,
    "readFile",
    function (this: typeof fs.promises, ...args: Parameters<typeof original>) {
      if (String(args[0]) === file) reads++;
      return original.apply(this, args);
    },
  );
  const { syncBuiltinESMExports } = await import("node:module");
  syncBuiltinESMExports();
  try {
    const display = new ToolDisplay(agentDir);
    const rows = await display.messages(
      [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "historical-edit",
              name: "edit",
              arguments: { path: file, oldText: "OLD", newText: "NEW" },
            },
          ],
        },
      ],
      dir,
      "historical",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(reads, 0);
    assert(!JSON.stringify(rows).includes("CURRENT PRIVATE FILE"));
    assert.equal(fs.readFileSync(file, "utf8"), "CURRENT PRIVATE FILE\n");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
