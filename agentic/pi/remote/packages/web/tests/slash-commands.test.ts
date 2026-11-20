import test from "node:test";
import assert from "node:assert/strict";
import {
  composerCommand,
  matchingCommands,
  slashQuery,
} from "../src/frontend/lib/slash-commands.ts";

const capabilities = [
  { name: "review", supported: true },
  { name: "reload", supported: false, reason: "Use the local terminal" },
  { name: "implement", supported: true },
  { name: "skill:python", supported: true },
];

test("slash completion only matches the command token at the start", () => {
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/RE"), "re");
  for (const text of ["hello /re", " /re", "/review ", "/review\n", "/tmp/file"])
    assert.equal(slashQuery(text), undefined, text);
  assert.deepEqual(
    matchingCommands("/re", capabilities).map((command) => command.name),
    ["review", "reload"],
  );
  assert.equal(matchingCommands("/", capabilities).length, 4);
  assert.deepEqual(matchingCommands("/nothing", capabilities), []);
  assert.deepEqual(matchingCommands("hello", capabilities), []);
  assert.equal(matchingCommands("/skill:p", capabilities)[0]?.name, "skill:python");
});

test("composer dispatches supported commands with optional and multiline arguments", () => {
  assert.deepEqual(composerCommand("/review", [], capabilities), {
    action: "slash", name: "review", args: "",
  });
  assert.deepEqual(composerCommand("/review   check this\nand that", [], capabilities), {
    action: "slash", name: "review", args: "check this\nand that",
  });
  assert.deepEqual(composerCommand("/skill:python explain this", [], capabilities), {
    action: "slash", name: "skill:python", args: "explain this",
  });
});

test("invalid or local-only commands cannot become ordinary prompts", () => {
  assert.throws(() => composerCommand("/", [], capabilities), /Choose a slash/);
  assert.throws(() => composerCommand("/unknown args", [], capabilities), /Unknown command/);
  assert.throws(() => composerCommand("/reload", [], capabilities), /Use the local terminal/);
  assert.throws(() => composerCommand("/review", ["image-id"], capabilities), /Remove attached images/);
});

test("ordinary messages and file paths keep text and images unchanged", () => {
  for (const text of ["Message /review", " /review", "/tmp/file", "", "normal text"])
    assert.deepEqual(composerCommand(text, ["image-id"], capabilities), {
      action: "message", text, images: ["image-id"],
    });
});
