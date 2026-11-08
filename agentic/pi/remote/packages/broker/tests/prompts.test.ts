import test from "node:test";
import assert from "node:assert/strict";
import {
  askRemote,
  configurePrompts,
  currentPrompt,
  respondPrompt,
} from "../../../../extensions/_remote_bridge/prompts.ts";
test.afterEach(() => configurePrompts());
test("phone answer wins once and aborts local UI", async () => {
  let cancelled = false;
  configurePrompts({
    publish: () => {},
    expire: () => {
      throw new Error("unexpected");
    },
  });
  const answer = askRemote(
    { question: "Proceed?", options: ["Yes", "No"] },
    (signal) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => {
          cancelled = true;
          resolve({ error: "aborted" });
        }),
      ),
  );
  const id = currentPrompt()!.id;
  respondPrompt(id, "Yes");
  assert.deepEqual(await answer, { answer: "Yes" });
  assert(cancelled);
  assert.throws(() => respondPrompt(id, "No"), /expired/);
});
test("fixed deadline expires without a guessed answer", async () => {
  let expired = 0;
  configurePrompts({ publish: () => {}, expire: () => expired++ });
  const result = await askRemote({ question: "Choose?" }, undefined, undefined, 15);
  assert.equal(result.error, "answer needed");
  assert.equal(expired, 1);
  assert.equal(currentPrompt(), undefined);
});
test("multi-select validates allowed choices and caller abort settles", async () => {
  configurePrompts({ publish: () => {}, expire: () => {} });
  const abort = new AbortController();
  const promise = askRemote(
    { question: "Pick", options: ["A", "B"], multiSelect: true },
    undefined,
    abort.signal,
  );
  assert.throws(() => respondPrompt(currentPrompt()!.id, ["C"]), /invalid/);
  abort.abort();
  assert.equal((await promise).error, "aborted");
});
