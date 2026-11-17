import type { Session } from "./index.ts";

export type ConversationStatus =
  "needs_input" | "failed" | "finished" | "running" | "idle";

export function conversationStatus(session: Session): ConversationStatus {
  if (
    session.prompt?.state === "pending" ||
    session.prompt?.state === "expired" ||
    ["waiting", "answer_needed"].includes(session.state)
  )
    return "needs_input";
  if (session.state === "running" || (session.loop && session.state === "idle"))
    return "running";
  return session.completion?.outcome ?? "idle";
}

export function conversationRank(session: Session): number {
  const status = conversationStatus(session);
  if (status === "needs_input" || status === "failed") return 0;
  if (status === "finished") return 1;
  if (status === "running") return 2;
  return session.state === "idle" ? 3 : 4;
}

/** Match iTerm2 attention priority, retaining the existing order within ties. */
export function orderConversations(rows: Session[], previous: Session[] = []) {
  const positions = new Map(
    previous.map((session, index) => [session.sessionId, index]),
  );
  const position = (session: Session) =>
    positions.get(session.sessionId) ?? previous.length + rows.indexOf(session);
  return [...rows].sort(
    (a, b) => conversationRank(a) - conversationRank(b) || position(a) - position(b),
  );
}
