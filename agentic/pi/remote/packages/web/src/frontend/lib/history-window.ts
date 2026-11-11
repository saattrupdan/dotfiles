import type { Message } from "../stores/sessions.ts";

export function sameMessage(a: Message, b: Message) {
  if (a.remoteHistoryKey && b.remoteHistoryKey)
    return a.remoteHistoryKey === b.remoteHistoryKey;
  return (
    a.role === b.role &&
    a.timestamp === b.timestamp &&
    a.toolCallId === b.toolCallId &&
    JSON.stringify(a.content) === JSON.stringify(b.content)
  );
}

/** Preserve an older window only when its native provenance overlaps the refresh. */
export function mergeHistory(
  current: Message[],
  incoming: Message[],
  keepOlder: boolean,
  live: Message[] = [],
) {
  const overlap = incoming.length
    ? current.findIndex((row) => sameMessage(row, incoming[0]!))
    : -1;
  const merged = [
    ...(keepOlder && overlap >= 0 ? current.slice(0, overlap) : []),
    ...incoming,
  ];
  for (const message of live)
    if (!merged.some((row) => sameMessage(row, message))) merged.push(message);
  return merged;
}

export async function windowProof(messages: Message[]) {
  const keys = messages
    .map((message) => message.remoteHistoryKey)
    .filter((key): key is string => typeof key === "string");
  if (!keys.length) return "";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(keys.join("\n")),
  );
  const proof = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `&anchor=${keys[0]}&count=${keys.length}&proof=${proof}`;
}
