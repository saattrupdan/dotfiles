import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { HistoryPages, historyKey } from "../src/history-pages.ts";
import { History } from "../src/history.ts";
import { ConfigSchema } from "../src/config.ts";

function rows(turns = 25) {
  return Array.from({ length: turns }, (_, index) => [
    { role: "user", content: `Question ${index + 1}`, timestamp: index * 4 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: `tool-${index}`,
          name: "read",
          arguments: { path: "fixture" },
        },
      ],
      timestamp: index * 4 + 1,
    },
    {
      role: "toolResult",
      toolCallId: `tool-${index}`,
      toolName: "read",
      content: `Result ${index + 1}`,
      timestamp: index * 4 + 2,
    },
    { role: "assistant", content: `Answer ${index + 1}`, timestamp: index * 4 + 3 },
  ])
    .flat()
    .map((message, index) => ({
      ...message,
      remoteHistoryKey: historyKey("fixture", index, message),
    }));
}

test("latest five turns preserve tools; older cursors pin one projection across appends", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-pages-"));
  const file = path.join(dir, "history");
  fs.writeFileSync(file, "first");
  let count = 0;
  let data = rows();
  const pages = new HistoryPages(async () => {
    count++;
    return { messages: data, truncated: false };
  });
  try {
    const latest = await pages.read(file, "native");
    assert.equal(latest.messages.length, 20);
    assert.equal(latest.messages[0]!.content, "Question 21");
    assert.equal(count, 1);
    const older = await pages.read(file, "native", { before: latest.older! });
    assert.equal(older.messages[0]!.content, "Question 16");
    assert.equal(count, 1);
    data = rows(26);
    fs.appendFileSync(file, "appended");
    const nativeKeys = rows()
      .slice(60)
      .map((row) => row.remoteHistoryKey);
    const fresh = await pages.read(file, "native", {
      anchor: older.messages[0]!.remoteHistoryKey as string,
      count: nativeKeys.length,
      proof: createHash("sha256").update(nativeKeys.join("\n")).digest("hex"),
    });
    assert.equal(count, 2);
    assert(fresh.anchorFound);
    assert(fresh.anchoredOlder);
    const changed = rows(26);
    changed[70] = {
      ...changed[70]!,
      remoteHistoryKey: historyKey("context-edit", 70, changed[70]),
    };
    data = changed;
    fs.appendFileSync(file, "context edit");
    const edited = await pages.read(file, "native", {
      anchor: older.messages[0]!.remoteHistoryKey as string,
      count: nativeKeys.length,
      proof: createHash("sha256").update(nativeKeys.join("\n")).digest("hex"),
    });
    assert.equal(
      edited.anchorFound,
      false,
      "Matching endpoints must not hide an edited middle message",
    );
    const anchored = await pages.read(file, "native", { before: fresh.anchoredOlder! });
    assert.equal(anchored.messages.at(-1)!.content, "Answer 15");
    const pinned = await pages.read(file, "native", { before: latest.older! });
    assert.equal(pinned.messages[0]!.content, "Question 16");
    assert.equal(pinned.revision, latest.revision);
    await assert.rejects(
      pages.read(file, "other", { before: latest.older! }),
      /history_cursor_expired/,
    );
    await assert.rejects(
      pages.read(file, "native", { before: "invalid" }),
      /history_cursor_expired/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot construction is single-flight and expired cursors reset explicitly", async (t) => {
  let finish!: (value: {
    messages: ReturnType<typeof rows>;
    truncated: boolean;
  }) => void;
  let count = 0;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const pages = new HistoryPages(async () => {
    count++;
    return new Promise((resolve) => (finish = resolve));
  });
  const first = pages.read("missing-fixture", "native");
  const second = pages.read("missing-fixture", "native");
  assert.equal(count, 1);
  finish({ messages: rows(), truncated: false });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.revision, b.revision);
  now += 300001;
  await assert.rejects(
    pages.read("missing-fixture", "native", { before: a.older! }),
    /history_cursor_expired/,
  );
});

test("native window projection follows the selected branch without writing history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-window-"));
  const file = path.join(root, "native.jsonl");
  const id = randomUUID();
  const entries: unknown[] = [
    { type: "session", version: 3, id, cwd: root, timestamp: new Date().toISOString() },
  ];
  let parent: string | null = null;
  for (let i = 0; i < 12; i++) {
    const key = `m${i}`;
    entries.push({
      type: "message",
      id: key,
      parentId: parent,
      message: {
        role: i % 2 ? "assistant" : "user",
        content: `Native ${i}`,
        timestamp: i,
      },
    });
    parent = key;
  }
  entries.push({
    type: "message",
    id: "abandoned",
    parentId: parent,
    message: { role: "user", content: "Abandoned branch", timestamp: 20 },
  });
  entries.push({
    type: "message",
    id: "selected",
    parentId: parent,
    message: { role: "user", content: "Selected branch", timestamp: 21 },
  });
  fs.writeFileSync(
    file,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const before = fs.readFileSync(file);
  const history = new History(
    ConfigSchema.parse({
      origin: "https://fixture.test.ts.net",
      home: root,
      agentDir: root,
      dataDir: path.join(root, "data"),
    }),
  );
  try {
    const first = await history.window(file, id, root);
    assert.equal(
      first.messages.filter((row) => (row as { role: unknown }).role === "user").length,
      5,
    );
    assert(!JSON.stringify(first.messages).includes("Abandoned branch"));
    assert(JSON.stringify(first.messages).includes("Selected branch"));
    assert(
      first.messages.every(
        (row) =>
          typeof (row as { remoteHistoryKey: unknown }).remoteHistoryKey === "string",
      ),
    );
    const all = [...first.messages];
    let cursor = first.older;
    while (cursor) {
      const page = await history.window(file, id, root, { before: cursor });
      all.unshift(...page.messages);
      cursor = page.older;
    }
    assert.equal(all.length, 13);
    assert.deepEqual(fs.readFileSync(file), before);
    await assert.rejects(history.window(file, randomUUID(), root), /session_changed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
