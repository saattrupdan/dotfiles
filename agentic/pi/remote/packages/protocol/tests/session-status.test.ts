import test from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/index.ts";
import { conversationStatus, orderConversations } from "../src/session-status.ts";

const session = (sessionId: string, state = "idle", outcome?: "finished" | "failed") =>
  ({
    sessionId,
    state,
    completion: outcome ? { id: sessionId, outcome } : undefined,
  }) as Session;

test("conversation statuses prioritize input and running over a terminal result", () => {
  assert.equal(conversationStatus(session("idle")), "idle");
  assert.equal(conversationStatus(session("running", "running")), "running");
  assert.equal(conversationStatus(session("done", "idle", "finished")), "finished");
  assert.equal(conversationStatus(session("failed", "idle", "failed")), "failed");
  assert.equal(conversationStatus(session("retry", "running", "failed")), "running");
  assert.equal(
    conversationStatus(session("question", "waiting", "finished")),
    "needs_input",
  );
  assert.equal(conversationStatus(session("expired", "answer_needed")), "needs_input");
  assert.equal(conversationStatus({ ...session("loop"), loop: true }), "running");
  assert.equal(conversationStatus(session("saved", "stopped")), "idle");
});

test("attention order matches iTerm2 and preserves existing ties across snapshots", () => {
  const running = session("working", "running"),
    idle = session("idle"),
    failed = session("failed", "idle", "failed"),
    finished = session("finished", "idle", "finished"),
    question = session("question", "waiting"),
    saved = session("saved", "stopped");
  const rows = [saved, running, idle, failed, finished, question];
  const first = orderConversations(rows);
  assert.deepEqual(
    first.map((row) => row.sessionId),
    ["failed", "question", "finished", "working", "idle", "saved"],
  );
  assert.deepEqual(orderConversations([...rows].reverse(), first), first);
  const other = session("other", "running");
  const previous = orderConversations([...first, other]);
  const next = orderConversations(
    [
      ...previous.map((row) =>
        row.sessionId === "finished" ? { ...row, completion: undefined } : row,
      ),
    ],
    previous,
  );
  assert.deepEqual(
    next.map((row) => row.sessionId),
    ["failed", "question", "working", "other", "finished", "idle", "saved"],
  );
});
