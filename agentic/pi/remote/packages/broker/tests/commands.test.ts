import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandCommandInput } from "../../../../extensions/_remote_bridge/command-input.ts";
import {
  registerRemoteCommand,
  invokeRemoteCommand,
  clearRemoteCommands,
} from "../../../../extensions/_remote_bridge/commands.ts";
test("typed command adapters acknowledge the actual handler and reject undiscovered commands", async () => {
  const context = {} as Parameters<typeof invokeRemoteCommand>[2];
  let received = "";
  registerRemoteCommand("fixture", async (args) => {
    received = args;
  });
  try {
    await invokeRemoteCommand("fixture", "verbatim arguments", context);
    assert.equal(received, "verbatim arguments");
    await assert.rejects(
      invokeRemoteCommand("unknown", "", context),
      /unsupported_command/,
    );
  } finally {
    clearRemoteCommands();
  }
});
test("main-profile template and skill inputs expand natively without dispatching arbitrary names", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-test-"));
  const prompt = path.join(root, "fixture.md"),
    skill = path.join(root, "SKILL.md");
  fs.writeFileSync(
    prompt,
    "---\ndescription: A fixture\n---\nFirst: $1\nAll: $ARGUMENTS\n",
  );
  fs.writeFileSync(
    skill,
    "---\nname: fixture\ndescription: Private frontmatter\n---\nRun the body.\n",
  );
  const source = (file: string) => ({
    path: file,
    scope: "user",
    source: "test",
    origin: "top-level",
  });
  const pi = {
    getCommands: () => [
      { name: "fixture", source: "prompt", sourceInfo: source(prompt) },
      { name: "skill:fixture", source: "skill", sourceInfo: source(skill) },
    ],
  } as unknown as Parameters<typeof expandCommandInput>[0];
  const ctx = { cwd: root } as Parameters<typeof expandCommandInput>[1];
  try {
    const expanded = await expandCommandInput(pi, ctx, "fixture", '"two words" tail');
    assert(expanded?.includes("First: two words"));
    assert(!expanded?.includes("description:"));
    const body = await expandCommandInput(pi, ctx, "skill:fixture", "Use safely.");
    assert(body?.includes("Run the body."));
    assert(body?.includes(`References are relative to ${root}`));
    assert(!body?.includes("Private frontmatter"));
    assert.equal(await expandCommandInput(pi, ctx, "unlisted", ""), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
