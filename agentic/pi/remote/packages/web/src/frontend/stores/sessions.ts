import { defineStore } from "pinia";
import { ref } from "vue";
import type { Session, Command, StreamEvent } from "../../../../protocol/src/index.ts";
import { useAuth, onLock } from "./auth.ts";
export interface Message {
  role?: string;
  content?:
    | string
    | Array<{
        type: string;
        text?: string;
        thinking?: string;
        data?: string;
        mimeType?: string;
        name?: string;
        arguments?: unknown;
      }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  customType?: string;
  [key: string]: unknown;
}
export const useSessions = defineStore("sessions", () => {
  const auth = useAuth();
  const sessions = ref<Session[]>([]);
  const messages = ref<Record<string, Message[]>>({});
  const streaming = ref<Record<string, Message | undefined>>({});
  const statuses = ref<Record<string, string>>({});
  const drafts = ref<Record<string, string>>({});
  const prompt = ref<
    Record<
      string,
      | {
          id: string;
          title: string;
          options?: string[];
          multiSelect?: boolean;
          deadline: number;
          state: string;
        }
      | undefined
    >
  >({});
  const pending = ref<
    Record<
      string,
      {
        sessionId: string;
        text: string;
        images: string[];
        status: string;
        command: Command;
      }
    >
  >({});
  let generation = 0;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let selected = "";
  function disconnect(clearSelection = false) {
    if (clearSelection) selected = "";
    socket?.close();
    socket = undefined;
    if (retry) clearTimeout(retry);
  }
  onLock(() => {
    generation++;
    disconnect();
    pending.value = {};
    sessions.value = [];
    messages.value = {};
    streaming.value = {};
    statuses.value = {};
    drafts.value = {};
    prompt.value = {};
    selected = "";
  });
  async function refresh() {
    const expected = generation;
    const result = await auth.request<Session[]>("/sessions");
    if (expected === generation && auth.unlocked) sessions.value = result;
  }
  async function history(id: string) {
    const expected = generation;
    let offset = 0;
    const all: Message[] = [];
    for (;;) {
      const page = await auth.request<{ messages: Message[]; next: number | null }>(
        `/sessions/${id}/history?offset=${offset}&limit=200`,
      );
      all.push(...page.messages);
      if (page.next === null) break;
      offset = page.next;
    }
    if (expected === generation && auth.unlocked) messages.value[id] = all;
  }
  function subscribe() {
    if (socket?.readyState === WebSocket.OPEN && selected)
      socket.send(
        JSON.stringify({
          subscriptions: [
            {
              sessionId: selected,
              sequence:
                sessions.value.find((s) => s.sessionId === selected)?.sequence ?? 0,
            },
          ],
        }),
      );
  }
  function connect(id: string) {
    selected = id;
    if (!auth.unlocked || !auth.visible) return;
    if (socket?.readyState === 0) return;
    if (socket?.readyState === WebSocket.OPEN) {
      subscribe();
      return;
    }
    disconnect();
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/events`,
    );
    socket = ws;
    ws.onopen = () => {
      subscribe();
      void refresh();
      void reconcile();
    };
    ws.onmessage = (e) => {
      if (!auth.unlocked || !auth.visible) return;
      const event = JSON.parse(e.data) as StreamEvent;
      const sid = event.sessionId;
      if (event.type === "sessions.changed") {
        void refresh();
        return;
      }
      if (!sid) return;
      const session = sessions.value.find((s) => s.sessionId === sid);
      if (session && event.sequence) session.sequence = event.sequence;
      if (event.type === "resnapshot") {
        void history(sid);
        void refresh();
      }
      if (event.type === "snapshot") {
        messages.value[sid] = event.data as Message[];
        streaming.value[sid] = undefined;
      }
      if (event.type === "message_update") streaming.value[sid] = event.data as Message;
      if (event.type === "message_end") {
        const message = event.data as Message;
        messages.value[sid] ??= [];
        if (
          !messages.value[sid]!.some(
            (existing) =>
              existing.role === message.role &&
              existing.timestamp === message.timestamp &&
              existing.toolCallId === message.toolCallId &&
              JSON.stringify(existing.content) === JSON.stringify(message.content),
          )
        )
          messages.value[sid]!.push(message);
        streaming.value[sid] = undefined;
      }
      if (event.type === "agent_settled") {
        void history(sid);
        void refresh();
      }
      if (event.type === "prompt") {
        prompt.value[sid] = event.data as (typeof prompt.value)[string];
        void refresh();
      }
      if (event.type === "prompt.expired") {
        if (prompt.value[sid]) prompt.value[sid]!.state = "expired";
      }
      if (event.type === "session.hidden") {
        delete messages.value[sid];
        delete drafts.value[sid];
        delete streaming.value[sid];
        void refresh();
      }
      if (event.type === "command.status") {
        const data = event.data as { id: string; status: string };
        statuses.value[data.id] = data.status;
        if (pending.value[data.id]) {
          pending.value[data.id]!.status = data.status;
          if (data.status === "persisted") delete pending.value[data.id];
        }
      }
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = undefined;
      if (event.code === 4001 || event.code === 4003) {
        auth.clear();
        return;
      }
      if (auth.unlocked && auth.visible)
        retry = setTimeout(() => {
          void history(id).catch(() => {});
          connect(id);
        }, 1500);
    };
  }
  function resume() {
    connect(selected);
    if (selected) void history(selected).catch(() => {});
    else void refresh().catch(() => {});
  }
  async function reconcile() {
    const expected = generation;
    for (const id of Object.keys(statuses.value)) {
      if (["persisted", "rejected"].includes(statuses.value[id]!)) continue;
      try {
        const known = await auth.request<{ status: string }>(`/commands/${id}`);
        if (expected !== generation || !auth.unlocked) return;
        statuses.value[id] = known.status;
        if (pending.value[id]) {
          pending.value[id]!.status = known.status;
          if (known.status === "persisted") delete pending.value[id];
        }
      } catch {
        /* Status lookup never re-injects a command. */
      }
    }
  }
  async function command(id: string, command: Command, retryOf?: string) {
    const session = sessions.value.find((s) => s.sessionId === id);
    if (!session?.epoch)
      throw new Error("Recover this conversation before sending commands.");
    const commandId = crypto.randomUUID();
    statuses.value[commandId] = "sending";
    if (command.action === "message" || command.action === "slash")
      pending.value[commandId] = {
        sessionId: id,
        text:
          command.action === "message"
            ? command.text
            : `/${command.name} ${command.args}`,
        images: command.action === "message" ? command.images : [],
        command,
        status: "sending",
      };
    try {
      const result = await auth.request<{ status: string }>(`/sessions/${id}/actions`, {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          sessionId: id,
          epoch: session.epoch,
          commandId,
          retryOf,
          command,
        }),
      });
      statuses.value[commandId] = result.status;
    } catch (e) {
      if (!auth.unlocked) throw e;
      statuses.value[commandId] = "delivery_unknown";
      try {
        const known = await auth.request<{ status: string }>(`/commands/${commandId}`);
        statuses.value[commandId] = known.status;
      } catch {
        /* Never re-inject a command after an uncertain response. */
      }
      if (pending.value[commandId])
        pending.value[commandId]!.status = statuses.value[commandId]!;
      throw e;
    }
    if (pending.value[commandId])
      pending.value[commandId]!.status = statuses.value[commandId]!;
    return commandId;
  }
  return {
    resume,
    pending,
    sessions,
    messages,
    streaming,
    statuses,
    drafts,
    prompt,
    refresh,
    history,
    connect,
    disconnect,
    command,
  };
});
