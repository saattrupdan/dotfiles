import type {
  ToolLineStyle,
  ToolProgress,
} from "../../../../../../extensions/_tool-display/block-types.ts";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  Session,
  SessionFolder,
  Command,
  StreamEvent,
} from "../../../../protocol/src/index.ts";
import { CommandStatus } from "../../../../protocol/src/index.ts";
import { mergeHistory, sameMessage, windowProof } from "../lib/history-window.ts";
import type { HistoryPage } from "../../../../protocol/src/index.ts";
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
        toolDisplayStyles?: ToolLineStyle[];
      }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  toolDisplay?: string;
  toolDisplayStyles?: ToolLineStyle[];
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
  const homeListing = ref<Session[]>([]);
  const homeLoaded = ref(false);
  const homeLoading = ref(false);
  const homeListingError = ref("");
  const homeFoldersError = ref("");
  const homeError = computed(() => homeListingError.value || homeFoldersError.value);
  const homeRequests = new Set<symbol>();
  let homeSessionsReady = false,
    homeFoldersReady = false;
  function beginHomeLoading() {
    const ticket = Symbol();
    homeRequests.add(ticket);
    homeLoading.value = true;
    return () => {
      if (homeRequests.delete(ticket)) homeLoading.value = homeRequests.size > 0;
    };
  }
  const homePosition = ref<{
    top: number;
    search: string;
    anchor?: { key: string; offset: number };
  }>();
  const folder = ref<string>();
  let currentFolder: string | undefined;
  let foldersRequest = 0;
  let listingRequest = 0;
  const messages = ref<Record<string, Message[]>>({});
  const streaming = ref<Record<string, Message | undefined>>({});
  const toolProgress = ref<Record<string, Record<string, ToolProgress>>>({});
  const historyLimited = ref<Record<string, boolean>>({});
  const historyPages = ref<
    Record<
      string,
      { older: string | null; revision: string; loading: boolean; error: string }
    >
  >({});
  const historyRequests = new Map<string, number>();
  const olderRequests = new Map<string, Promise<void>>();
  const latestRequests = new Map<string, Promise<void>>();
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
  let finishConnection: (() => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let selected = "";
  let metadataRequest = 0;
  let activityGeneration = 0;
  const acceptedMetadata = new Map<string, number>();
  function clearActivity() {
    toolProgress.value = {};
    activityGeneration++;
    for (const row of [...sessions.value, ...listing.value, ...homeListing.value])
      row.workingMessage = undefined;
  }
  function disconnect(clearSelection = false) {
    clearActivity();
    if (clearSelection) selected = "";
    finishConnection?.();
    finishConnection = undefined;
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
    acceptedMetadata.clear();
    folders.value = [];
    listing.value = [];
    homeListing.value = [];
    homeLoaded.value = false;
    homeRequests.clear();
    homeLoading.value = false;
    homeListingError.value = "";
    homeFoldersError.value = "";
    homeSessionsReady = false;
    homeFoldersReady = false;
    homePosition.value = undefined;
    currentFolder = undefined;
    folder.value = undefined;
    messages.value = {};
    streaming.value = {};
    historyLimited.value = {};
    historyPages.value = {};
    historyRequests.clear();
    olderRequests.clear();
    latestRequests.clear();
    statuses.value = {};
    drafts.value = {};
    prompt.value = {};
    selected = "";
  });
  async function loadFolders() {
    currentFolder = undefined;
    const expected = generation;
    const request = ++foldersRequest;
    const finish = beginHomeLoading();
    homeFoldersError.value = "";
    const readFolders = async () => {
      try {
        const result = await auth.request<SessionFolder[]>("/session-folders");
        if (
          expected === generation &&
          auth.unlocked &&
          currentFolder === undefined &&
          request === foldersRequest
        ) {
          folders.value = result;
          homeFoldersReady = true;
          homeLoaded.value = homeSessionsReady;
        }
      } catch (error) {
        if (
          expected === generation &&
          auth.unlocked &&
          currentFolder === undefined &&
          request === foldersRequest
        )
          homeFoldersError.value =
            error instanceof Error ? error.message : "Could not load folders";
        throw error;
      } finally {
        finish();
      }
    };
    await Promise.all([readFolders(), refresh()]);
  }
  function merge(
    rows: Session[],
    request = ++metadataRequest,
    activity = activityGeneration,
  ) {
    const accepted: Session[] = [];
    const known = new Map(
      sessions.value.map((session) => [session.sessionId, session]),
    );
    for (const row of rows) {
      const previous = known.get(row.sessionId);
      if ((acceptedMetadata.get(row.sessionId) ?? 0) > request) {
        if (previous) accepted.push(previous);
        continue;
      }
      acceptedMetadata.set(row.sessionId, request);
      if (
        (previous && previous.epoch !== row.epoch) ||
        ["stopped", "interrupted", "disconnected"].includes(row.state)
      )
        delete toolProgress.value[row.sessionId];
      if (
        previous &&
        previous.epoch === row.epoch &&
        previous.sequence > row.sequence &&
        !["stopped", "interrupted", "disconnected"].includes(row.state)
      ) {
        row.workingMessage = previous.workingMessage;
        row.sequence = previous.sequence;
      }
      if (activity !== activityGeneration) row.workingMessage = undefined;
      known.set(row.sessionId, row);
      accepted.push(row);
    }
    sessions.value = [...known.values()];
    return accepted;
  }
  async function refresh(folder = currentFolder) {
    currentFolder = folder;
    const expected = generation;
    const request = ++listingRequest;
    const metadata = ++metadataRequest;
    const activity = activityGeneration;
    const finish = folder === undefined ? beginHomeLoading() : () => {};
    if (folder === undefined) homeListingError.value = "";
    try {
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
        const rows = merge(result, metadata, activity);
        listing.value = rows;
        if (folder === undefined) {
          homeListing.value = rows;
          homeSessionsReady = true;
          homeLoaded.value = homeFoldersReady;
        }
      }
    } catch (error) {
      if (
        folder === undefined &&
        expected === generation &&
        auth.unlocked &&
        currentFolder === folder &&
        request === listingRequest
      )
        homeListingError.value =
          error instanceof Error ? error.message : "Could not load active sessions";
      throw error;
    } finally {
      finish();
    }
  }
  async function detail(id: string) {
    const expected = generation;
    const request = ++metadataRequest;
    const activity = activityGeneration;
    const result = await auth.request<Session>(`/sessions/${id}`);
    if (expected === generation && auth.unlocked) merge([result], request, activity);
  }
  function persistHistory(id: string, records: Message[]) {
    for (const message of records) {
      const commandId = remoteCommandId(message);
      if (
        commandId &&
        commandSessions.value[commandId] === id &&
        statuses.value[commandId] !== "rejected"
      )
        updateStatus(commandId, "persisted");
    }
    retireOutgoing(records);
  }
  function history(id: string, reset = false): Promise<void> {
    const task = readHistory(id, reset).finally(() => {
      if (latestRequests.get(id) === task) latestRequests.delete(id);
    });
    latestRequests.set(id, task);
    return task;
  }
  async function readHistory(id: string, reset: boolean) {
    const expected = generation;
    const request = (historyRequests.get(id) ?? 0) + 1;
    historyRequests.set(id, request);
    const previous = [...(messages.value[id] ?? [])];
    const baseline = new Set(previous);
    const proof =
      !reset && previous.some((message) => typeof message.remoteHistoryKey === "string")
        ? await windowProof(previous)
        : "";
    if (
      expected !== generation ||
      !auth.unlocked ||
      historyRequests.get(id) !== request
    )
      return;
    const page = await auth.request<HistoryPage>(
      `/sessions/${id}/history?window=latest${proof}`,
    );
    if (
      expected !== generation ||
      !auth.unlocked ||
      historyRequests.get(id) !== request
    )
      return;
    const incoming = page.messages.map((message) => ({
      ...message,
      remotePersisted: true,
    }));
    const live = (messages.value[id] ?? []).filter(
      (message) => !message.remoteHistoryKey && !baseline.has(message),
    );
    const keep =
      !reset &&
      page.anchorFound === true &&
      incoming.length > 0 &&
      previous.some((message) => sameMessage(message, incoming[0]!));
    messages.value[id] = mergeHistory(previous, incoming, keep, live);
    persistHistory(id, incoming);
    historyLimited.value[id] = Boolean(page.truncated);
    historyPages.value[id] = {
      revision: page.revision,
      older: keep ? (page.anchoredOlder ?? null) : (page.older ?? null),
      loading: false,
      error: "",
    };
  }
  function loadOlder(id: string): Promise<void> {
    const running = olderRequests.get(id);
    if (running) return running;
    const expected = generation;
    const task = (async () => {
      try {
        while (latestRequests.has(id)) await latestRequests.get(id);
      } catch (error) {
        if (expected === generation && historyPages.value[id])
          historyPages.value[id]!.error = (error as Error).message;
        return;
      }
      if (expected !== generation || !auth.unlocked) return;
      for (let attempt = 0; attempt < 2; attempt++) {
        const state = historyPages.value[id];
        if (!state?.older) return;
        const request = historyRequests.get(id);
        state.loading = true;
        state.error = "";
        try {
          const page = await auth.request<HistoryPage>(
            `/sessions/${id}/history?before=${encodeURIComponent(state.older)}`,
          );
          if (
            expected !== generation ||
            !auth.unlocked ||
            request !== historyRequests.get(id) ||
            historyPages.value[id]?.revision !== page.revision
          )
            return;
          const incoming = page.messages.map((message) => ({
            ...message,
            remotePersisted: true,
          }));
          const current = messages.value[id] ?? [];
          messages.value[id] = [
            ...incoming.filter(
              (message) => !current.some((row) => sameMessage(row, message)),
            ),
            ...current,
          ];
          state.older = page.older;
          persistHistory(id, incoming);
          return;
        } catch (error) {
          if (expected !== generation || !auth.unlocked) return;
          if (attempt === 0 && (error as Error).message === "history_cursor_expired") {
            await history(id);
            continue;
          }
          state.error = (error as Error).message;
          return;
        } finally {
          state.loading = false;
        }
      }
    })().finally(() => {
      if (olderRequests.get(id) === task) olderRequests.delete(id);
    });
    olderRequests.set(id, task);
    return task;
  }
  function subscribe() {
    if (socket?.readyState === WebSocket.OPEN && selected)
      socket.send(
        JSON.stringify({
          historyWindow: true,
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
    const connected = beginHomeLoading();
    finishConnection = connected;
    let opened = false;
    ws.onopen = () => {
      if (socket !== ws) return;
      opened = true;
      subscribe();
      void refresh().catch(() => {});
      connected();
      if (finishConnection === connected) finishConnection = undefined;
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
      const staleStatus =
        session && event.sequence !== undefined && event.sequence < session.sequence;
      if (session && event.sequence)
        session.sequence = Math.max(session.sequence, event.sequence);
      if (event.type === "working_status" && session && !staleStatus) {
        const data = event.data as { message?: unknown };
        session.workingMessage =
          typeof data?.message === "string" ? data.message : undefined;
      }
      if (event.type === "resnapshot") {
        void history(sid).catch(() => {});
        void refresh().catch(() => {});
      }
      if (event.type === "snapshot") {
        void history(sid, true).catch(() => {});
        streaming.value[sid] = undefined;
      }
      if (event.type === "message_update") streaming.value[sid] = event.data as Message;
      if (event.type === "message_end") {
        const complete = event.data as Message;
        if (complete.role === "toolResult" && complete.toolCallId)
          delete toolProgress.value[sid]?.[complete.toolCallId];
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

      if (event.type === "tool_execution_end")
        delete toolProgress.value[sid]?.[
          (event.data as { toolCallId: string }).toolCallId
        ];
      if (event.type === "tool_progress") {
        const progress = event.data as ToolProgress;
        if (
          !["stopped", "interrupted", "disconnected"].includes(
            sessions.value.find((row) => row.sessionId === sid)?.state ?? "",
          ) &&
          typeof progress?.toolCallId === "string" &&
          typeof progress.toolDisplay === "string"
        ) {
          const current = toolProgress.value[sid] ?? (toolProgress.value[sid] = {});
          delete current[progress.toolCallId];
          current[progress.toolCallId] = progress;
          while (Object.keys(current).length > 16)
            delete current[Object.keys(current)[0]!];
        }
      }
      if (event.type === "tool_progress_snapshot")
        toolProgress.value[sid] = Object.fromEntries(
          (event.data as ToolProgress[]).map((progress) => [
            progress.toolCallId,
            progress,
          ]),
        );
      if (event.type === "agent_start" || event.type === "agent_settled")
        delete toolProgress.value[sid];
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
        historyRequests.set(sid, (historyRequests.get(sid) ?? 0) + 1);
        delete historyPages.value[sid];
        homeListing.value = homeListing.value.filter((row) => row.sessionId !== sid);
        delete messages.value[sid];
        delete drafts.value[sid];
        delete streaming.value[sid];
        delete toolProgress.value[sid];
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
      connected();
      if (finishConnection === connected) finishConnection = undefined;
      if (!opened && auth.unlocked && auth.visible && currentFolder === undefined)
        homeListingError.value = "Could not connect to live sessions. Try again.";
      clearActivity();
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
    if (session.controlBlockedReason) throw new Error(session.controlBlockedReason);
    if (session.recoveryBlockedReason)
      throw new Error(
        "This conversation cannot connect yet. Check the connection message above.",
      );
    if (
      !session.epoch ||
      ["stopped", "crashed", "interrupted"].includes(session.state)
    ) {
      let result: Session;
      try {
        result = await auth.request<Session>(`/sessions/${id}/recover`, {
          method: "POST",
          body: "{}",
        });
      } catch (error) {
        if (error instanceof Error && error.message === "session_still_running")
          throw new Error(
            "Pi is still running on your Mac. Wait for it to reconnect before sending.",
          );
        throw error;
      }
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
    if (session?.controlBlockedReason) throw new Error(session.controlBlockedReason);
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
      if (statuses.value[commandId] === "persisted") return commandId;
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
    historyPages,
    loadOlder,
    folders,
    listing,
    homeListing,
    homeLoaded,
    homeLoading,
    homeError,
    homePosition,
    loadFolders,
    detail,
    resume,
    pending,
    sessions,
    messages,
    streaming,
    toolProgress,
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
