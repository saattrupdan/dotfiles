import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import * as ownership from "../../../../extensions/_session_ownership/ownership.mjs";

test("pilot native resume neither discovers nor publishes global legacy histories", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-resume-"));
  const scope = path.join(root, "pilot");
  fs.mkdirSync(scope);
  const previous = process.env.PI_SESSION_HISTORY_SCOPE;
  process.env.PI_SESSION_HISTORY_SCOPE = scope;
  try {
    const source = fs.readFileSync(
      new URL("../../../../extensions/session-ownership/index.ts", import.meta.url),
      "utf8",
    );
    const body = source.slice(
      source.indexOf("async function resume("),
      source.indexOf("\nasync function choose("),
    );
    const calls: (string | undefined)[] = [];
    let labels: string[] = [];
    const own = {
      path: path.join(scope, "own.jsonl"),
      id: "own",
      name: "Pilot",
      firstMessage: "Pilot",
      cwd: root,
      modified: new Date(),
    };
    const legacy = {
      ...own,
      path: path.join(root, "legacy.jsonl"),
      id: "legacy",
      name: "LEGACY_PRIVATE_METADATA",
    };
    const resume = runInNewContext(
      transformSync(body + "\nresume;", { loader: "ts" }).code,
      {
        process,
        fs,
        path,
        historyInScope: ownership.historyInScope,
        SessionManager: {
          listAll: async (dir?: string) => {
            calls.push(dir);
            return [legacy, own];
          },
        },
        isLoopActive: () => false,
        choose: async (_ctx: unknown, _title: string, options: string[]) => {
          labels = options;
        },
      },
    );
    await resume(
      "",
      {
        waitForIdle: async () => {},
        sessionManager: { getSessionDir: () => root },
        ui: { notify: () => {}, setWorkingMessage: () => {} },
      },
      { current: "current" },
    );
    assert.equal(labels.length, 1);
    assert(!labels.some((label) => label.includes("LEGACY_PRIVATE_METADATA")));
    assert.deepEqual(calls, [fs.realpathSync(scope)]);
  } finally {
    if (previous === undefined) delete process.env.PI_SESSION_HISTORY_SCOPE;
    else process.env.PI_SESSION_HISTORY_SCOPE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
