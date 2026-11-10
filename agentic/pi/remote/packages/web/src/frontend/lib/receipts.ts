import type { Message } from "../stores/sessions.ts";

const marker = /<!-- pi-remote-command:([0-9a-f-]{36}) -->/;

export function remoteCommandId(message: Message): string | undefined {
  if (message.role !== "user") return;
  const content =
    typeof message.content === "string"
      ? message.content
      : (message.content ?? []).map((part) => part.text ?? "").join("\n");
  return marker.exec(content)?.[1];
}

/** A live message alone is not proof that the native owner persisted it. */
export function messageReceipt(message: Message, statuses: Record<string, string>) {
  const id = remoteCommandId(message);
  if (!id) return;
  const status = statuses[id];
  if (status === "rejected") return status;
  if (message.remotePersisted === true || status === "persisted") return "received";
  return status === "delivery_unknown" ? status : "pending";
}

export function receiptLabel(status: string): string {
  const labels: Record<string, string> = {
    received: "Received by your laptop",
    pending: "Waiting for your laptop",
    rejected: "Message rejected",
    delivery_unknown: "Delivery unknown. Check the conversation before retrying.",
  };
  return labels[status] ?? "Waiting for your laptop";
}
