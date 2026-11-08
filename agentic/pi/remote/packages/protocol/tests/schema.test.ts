import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Envelope } from "../src/index.ts";
test("wire schema rejects arbitrary execution, private profiles and invalid epochs", () => {
  for (const command of [
    { action: "exec", command: "whoami" },
    { action: "message", text: "ok", images: ["../../secret"] },
  ])
    assert(
      !Envelope.safeParse({
        version: 1,
        commandId: randomUUID(),
        sessionId: randomUUID(),
        epoch: 1,
        command,
      }).success,
    );
  assert(
    !Envelope.safeParse({
      version: 2,
      commandId: randomUUID(),
      sessionId: randomUUID(),
      epoch: 1,
      command: { action: "stop_run" },
    }).success,
  );
});
