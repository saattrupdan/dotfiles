import { defineStore } from "pinia";
import { ref } from "vue";
import type {
  Session,
  SessionFolder,
  Command,
  StreamEvent,
} from "../../../../protocol/src/index.ts";
import { CommandStatus } from "../../../../protocol/src/index.ts";
import { remoteCommandId } from "../lib/receipts.ts";
import { useAuth, onLock } from "./auth.ts";
export interface Message {
  role?: string;
  content?:
    | string
    | Array<{
        type: string;
        id?: string;
        text?: string;
        thinking?: string;
        data?: string;
        mimeType?: string;
        name?: string;
        arguments?: unknown;
        toolDisplay?: string;
      }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  toolDisplay?: string;
  remotePersisted?: boolean;
  timestamp?: number;
  customType?: string;
  [key: string]: unknown;
}
export const useSessions = defineStore("sessions", () => {
  const auth = useAuth();
  const sessions = ref<Session[]>([]);
  const folders = ref<SessionFolder[]>([]);
  const listing = ref<Session[]>([]);
  const folder = ref<string>();
  let currentFolder: string | undefined;
  let foldersRequest = 0;
  let listingRequest = 0;
  const messages = ref<Record<string, Message[]>>({});
  const streaming = ref<Record<string, Message | undefined>>({});
  const historyLimited = ref<Record<string, boolean>>({});
  const statuses = ref<Record<string, string>>({});
  const commandSessions = ref<Record<string, string>>({});
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
  const outgoing = ref<typeof pending.value>({});
  function updateStatus(id: string, status: string) {
    if (statuses.value[id] === "persisted" && status !== "rejected") return;
    statuses.value[id] = status;
    if (outgoing.value[id]) outgoing.value[id]!.status = status;
    if (pending.value[id]) {
      pending.value[id]!.status = status;
      if (status === "persisted") delete pending.value[id];
    }
  }
  function retireOutgoing(records: Message[]) {
    for (const message of records) {
      const id = remoteCommandId(message);
      if (id) delete outgoing.value[id];
    }
  }
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
    outgoing.value = {};
    commandSessions.value = {};
    sessions.value = [];
    folders.value = [];
    listing.value = [];
    currentFolder = undefined;
    folder.value = undefined;
    messages.value = {};
    streaming.value = {};
    historyLimited.value = {};
    statuses.value = {};
    drafts.value = {};
    prompt.value = {};
    selected = "";
  });
  async function loadFolders() {
    currentFolder = undefined;
    const expected = generation;
    const request = ++foldersRequest;
    const [result] = await Promise.all([
      auth.request<SessionFolder[]>("/session-folders"),
      refresh(),
    ]);
    if (
      expected === generation &&
      auth.unlocked &&
      currentFolder === undefined &&
      request === foldersRequest
    )
      folders.value = result;
  }
  function merge(rows: Session[]) {
    const known = new Map(
      sessions.value.map((session) => [session.sessionId, session]),
    );
    for (const row of rows) known.set(row.sessionId, row);
    sessions.value = [...known.values()];
  }
  async function refresh(folder = currentFolder) {
    currentFolder = folder;
    const expected = generation;
    const request = ++listingRequest;
    const result = await auth.request<Session[]>(
      folder === undefined
        ? "/sessions"
        : `/sessions?folder=${encodeURIComponent(folder)}`,
    );
    if (
      expected === generation &&
      auth.unlocked &&
      currentFolder === folder &&
      request === listingRequest
    ) {
      listing.value = result;
      merge(result);
    }
  }
  async function detail(id: string) {
    const expected = generation;
    const result = await auth.request<Session>(`/sessions/${id}`);
    if (expected === generation && auth.unlocked) merge([result]);
  }
  async function history(id: string) {
    const expected = generation;
    let offset = 0;
    const all: Message[] = [];
    let limited = false;
    for (;;) {
      const page = await auth.request<{
        messages: Message[];
        next: number | null;
        truncated?: boolean;
      }>(`/sessions/${id}/history?offset=${offset}&limit=200`);
      all.push(...page.messages);
      limited ||= Boolean(page.truncated);
      if (page.next === null) break;
      offset = page.next;
    }
    if (expected === generation && auth.unlocked) {
      messages.value[id] = all.map((message) => ({
        ...message,
        remotePersisted: true,
      }));
      for (const message of all) {
        const commandId = remoteCommandId(message);
        if (
          commandId &&
          commandSessions.value[commandId] === id &&
          statuses.value[commandId] !== "rejected"
        )
          updateStatus(commandId, "persisted");
      }
      retireOutgoing(all);
      historyLimited.value[id] = limited;
    }
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
      if (socket !== ws) return;
      subscribe();
      void refresh().catch(() => {});
      void reconcile();
    };
    ws.onmessage = (e) => {
      if (socket !== ws || !auth.unlocked || !auth.visible) return;
      const event = JSON.parse(e.data) as StreamEvent;
      const sid = event.sessionId;
      if (event.type === "sessions.changed") {
        if (selected) void detail(selected).catch(() => {});
        if (currentFolder === undefined && !selected)
          void loadFolders().catch(() => {});
        else void refresh().catch(() => {});
        return;
      }
      if (!sid) return;
      const session = sessions.value.find((s) => s.sessionId === sid);
      if (session && event.sequence) session.sequence = event.sequence;
      if (event.type === "resnapshot") {
        void history(sid).catch(() => {});
        void refresh().catch(() => {});
      }
      if (event.type === "snapshot") {
        messages.value[sid] = event.data as Message[];
        retireOutgoing(messages.value[sid]!);
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
        retireOutgoing([message]);
        streaming.value[sid] = undefined;
      }
      if (event.type === "agent_settled") {
        void history(sid).catch(() => {});
        void refresh().catch(() => {});
      }
      if (event.type === "prompt") {
        prompt.value[sid] = event.data as (typeof prompt.value)[string];
        void refresh().catch(() => {});
      }
      if (event.type === "prompt.expired") {
        if (prompt.value[sid]) prompt.value[sid]!.state = "expired";
      }
      if (event.type === "session.hidden") {
        delete messages.value[sid];
        delete drafts.value[sid];
        delete streaming.value[sid];
        void refresh().catch(() => {});
      }
      if (event.type === "command.status") {
        const data = event.data as { id: string; status: string };
        const status = CommandStatus.safeParse(data.status);
        if (!status.success) return;
        commandSessions.value[data.id] = sid;
        updateStatus(data.id, status.data);
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
        const status = CommandStatus.parse(known.status);
        updateStatus(id, status);
      } catch {
        /* Status lookup never re-injects a command. */
      }
    }
  }
  async function ensureOwner(id: string) {
    const expected = generation;
    let session = sessions.value.find((s) => s.sessionId === id);
    if (!session) {
      await detail(id);
      session = sessions.value.find((s) => s.sessionId === id);
    }
    if (!session) throw new Error("Conversation not found.");
    if (session.recoveryBlockedReason)
      throw new Error(
        "This conversation cannot connect yet. Check the connection message above.",
      );
    if (
      !session.epoch ||
      ["stopped", "crashed", "interrupted"].includes(session.state)
    ) {
      const result = await auth.request<Session>(`/sessions/${id}/recover`, {
        method: "POST",
        body: "{}",
      });
      if (expected !== generation || !auth.unlocked) throw new Error("Session locked.");
      merge([result]);
      session = result;
      connect(id);
    }
    if (!session.epoch)
      throw new Error("Pi has not connected. Your message has not been sent.");
    return session;
  }
  async function command(id: string, command: Command, retryOf?: string) {
    const expected = generation;
    if (command.action === "message") await ensureOwner(id);
    if (expected !== generation || !auth.unlocked) throw new Error("Session locked.");
    const session = sessions.value.find((s) => s.sessionId === id);
    if (!session?.epoch)
      throw new Error("Resume this conversation on your Mac before sending commands.");
    const commandId = crypto.randomUUID();
    commandSessions.value[commandId] = id;
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
    if (pending.value[commandId]) outgoing.value[commandId] = pending.value[commandId]!;
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
      if (expected !== generation || !auth.unlocked) throw new Error("Session locked.");
      updateStatus(commandId, CommandStatus.parse(result.status));
    } catch (e) {
      if (expected !== generation || !auth.unlocked) throw e;
      updateStatus(commandId, "delivery_unknown");
      try {
        const known = await auth.request<{ status: string }>(`/commands/${commandId}`);
        if (expected !== generation || !auth.unlocked) throw e;
        updateStatus(commandId, CommandStatus.parse(known.status));
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
    folder,
    outgoing,
    commandSessions,
    ensureOwner,
    historyLimited,
    folders,
    listing,
    loadFolders,
    detail,
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
