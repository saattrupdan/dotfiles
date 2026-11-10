import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import * as ownership from "../../../../extensions/_session_ownership/ownership.mjs";

function fixture(t: TestContext, scoped = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-resume-"));
  const scope = path.join(root, "pilot");
  fs.mkdirSync(scope);
  const previous = { scope: process.env.PI_SESSION_HISTORY_SCOPE, agent: process.env.PI_CODING_AGENT_DIR };
  process.env.PI_CODING_AGENT_DIR = root;
  if (scoped) process.env.PI_SESSION_HISTORY_SCOPE = scope;
  else delete process.env.PI_SESSION_HISTORY_SCOPE;
  t.after(() => {
    for (const [key, value] of [["PI_SESSION_HISTORY_SCOPE", previous.scope], ["PI_CODING_AGENT_DIR", previous.agent]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const own = { path: path.join(scope, "own.jsonl"), id: "own", name: "Pilot", cwd: root };
  const legacy = { ...own, path: path.join(root, "legacy.jsonl"), id: "legacy", name: "LEGACY_PRIVATE_METADATA" };
  for (const row of [own, legacy]) fs.writeFileSync(row.path, JSON.stringify({ type: "session", id: row.id }) + "\n");
  const calls: unknown[][] = [];
  const mutations: string[] = [];
  const notices: string[] = [];
  const controller = new AbortController();
  let component: NativePicker;
  class NativePicker {
    list = { onDeleteSession: async (file: string) => { mutations.push(file); }, handleInput: () => {} };
    constructor(
      readonly current: (...args: unknown[]) => Promise<unknown[]>,
      readonly all: (...args: unknown[]) => Promise<unknown[]>,
      readonly select: (file: string) => void,
      readonly cancel: () => void,
      readonly exit: () => void,
      _render: unknown,
      readonly options: { renameSession: (file: string, name: string) => Promise<void> },
    ) {}
    getSessionList() { return this.list; }
    handleInput() { this.cancel(); }
  }
  const source = fs.readFileSync(new URL("../../../../extensions/session-ownership/index.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function selectSession("), source.indexOf("\nasync function choose("));
  const selectSession = runInNewContext(transformSync(body + "\nselectSession;", { loader: "ts" }).code, {
    process, fs, path,
    ...ownership,
    interactiveQueue: { run: (operation: (signal: AbortSignal) => unknown) => operation(controller.signal) },
    SessionSelectorComponent: NativePicker,
    SessionManager: {
      list: async (...args: unknown[]) => {
        calls.push(args);
        (args[2] as (loaded: number, total: number, partial: unknown[]) => void)(2, 2, [legacy, own]);
        return [legacy, own];
      },
      listAll: async (...args: unknown[]) => { calls.push(args); return [legacy, own]; },
      open: (file: string) => ({ appendSessionInfo: () => mutations.push(file) }),
    },
  });
  const directory = path.join(root, "sessions", `--${root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  const context = {
    cwd: root,
    sessionManager: { getSessionDir: () => directory },
    ui: {
      custom: (factory: (...args: unknown[]) => NativePicker) => new Promise((resolve) => {
        component = factory({ requestRender() {} }, {}, {}, resolve);
      }),
      select: () => { throw new Error("Generic question picker must not open"); },
      notify: (message: string) => notices.push(message),
    },
  };
  const state = { owner: ownership.newOwner(), root: path.join(root, "locks"), current: "current" };
  const result = selectSession(context, state, "");
  return { root, scope, own, legacy, calls, mutations, notices, state, result, picker: () => component, controller };
}

test("native resume opens immediately and loads all projects only when requested", async (t) => {
  const f = fixture(t);
  assert(f.picker());
  assert.equal(f.calls.length, 0);
  await f.picker().current();
  assert.equal(f.calls.length, 1);
  await f.picker().all();
  assert.equal(typeof f.calls[1]![0], "function", "default history uses native global loader");
  f.picker().select(f.own.path);
  assert.equal((await f.result).id, "own");
});

test("pilot native picker filters final and incremental rows without global discovery", async (t) => {
  const f = fixture(t, true);
  let published: unknown[] = [];
  const rows = await f.picker().current((_loaded: number, _total: number, partial: unknown[]) => { published = partial; });
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [f.own]);
  assert.deepEqual(JSON.parse(JSON.stringify(published)), [f.own]);
  await f.picker().all();
  assert.equal(f.calls[0]![1], f.scope);
  assert.equal(f.calls[1]![0], f.scope);
  f.controller.abort();
  assert.equal(await f.result, undefined);
});

test("native rename and delete retain exclusive ownership checks", async (t) => {
  const f = fixture(t);
  const other = ownership.newOwner();
  ownership.acquire(f.own.path, other, f.state.root, "own");
  await assert.doesNotReject(f.picker().options.renameSession(f.own.path, "New"));
  await assert.doesNotReject(f.picker().list.onDeleteSession(f.own.path));
  assert.equal(f.notices.length, 2);
  assert(f.notices.every((message) => message.includes("owned by")));
  assert.deepEqual(f.mutations, []);
  ownership.release(f.own.path, other, f.state.root);
  await f.picker().options.renameSession(f.own.path, "New");
  await f.picker().list.onDeleteSession(f.own.path);
  assert.deepEqual(f.mutations, [f.own.path, f.own.path]);
  assert.equal(ownership.inspect(f.own.path, f.state.root), undefined);
  f.picker().cancel();
  await f.result;
});
