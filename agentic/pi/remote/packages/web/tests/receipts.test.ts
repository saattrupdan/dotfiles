import test from "node:test";
import assert from "node:assert/strict";
import { remoteCommandId, messageReceipt } from "../src/frontend/lib/receipts.ts";
import { isUsersDirectory } from "../src/frontend/lib/session-paths.ts";
const id = "c2d90aba-4820-494b-978d-1991e3e820cf";
const message = {
  role: "user",
  content: `<!-- pi-remote-command:${id} -->\nSent from my phone`,
};

test("a tick means native persistence, not broker or owner acceptance", () => {
  assert.equal(remoteCommandId(message), id);
  for (const status of ["sending", "queued", "forwarded", "accepted_by_owner"])
    assert.equal(messageReceipt(message, { [id]: status }), "pending");
  assert.equal(messageReceipt(message, { [id]: "persisted" }), "received");
  assert.equal(messageReceipt({ ...message, remotePersisted: true }, {}), "received");
  assert.equal(
    messageReceipt({ ...message, remotePersisted: true }, { [id]: "delivery_unknown" }),
    "received",
  );
  assert.equal(
    messageReceipt(message, { [id]: "delivery_unknown" }),
    "delivery_unknown",
  );
  assert.equal(messageReceipt(message, { [id]: "rejected" }), "rejected");
  assert.equal(
    messageReceipt({ role: "assistant", content: message.content }, {}),
    undefined,
  );
  assert.equal(
    messageReceipt({ role: "user", content: "Sent on the laptop" }, {}),
    undefined,
  );
});

test("only user-directory folders appear in phone navigation", () => {
  for (const cwd of ["/Users/dan", "/Users/dan/gitsky/project", "/Users/other/project"])
    assert(isUsersDirectory(cwd), cwd);
  for (const cwd of [
    undefined,
    "/Users",
    "/Users/",
    "/Users-old/project",
    "/private/var/tmp/session",
    "/tmp/project",
    "/Users/../private/project",
    "/Users/dan/../../private/project",
  ])
    assert(!isUsersDirectory(cwd), String(cwd));
});
