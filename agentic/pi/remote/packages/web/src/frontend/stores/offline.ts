import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useAuth, onUnpair } from "./auth.ts";
import {
  OfflineLibrary,
  type OfflineCopy,
  type OfflineSummary,
} from "../lib/offline-library.ts";
import type { Message } from "./sessions.ts";
import { windowProof } from "../lib/history-window.ts";
import type { HistoryPage, Session } from "../../../../protocol/src/index.ts";

export const useOffline = defineStore("offline", () => {
  const auth = useAuth();
  const library = new OfflineLibrary();
  const copies = ref<OfflineCopy[]>([]);
  const active = ref(false);
  const sessions = computed<Session[]>(() =>
    copies.value.map((copy) => ({
      sessionId: copy.sessionId,
      name: copy.name ?? "",
      cwd: copy.cwd,
      lastActivity: copy.lastActivity,
      state: "idle",
      epoch: 0,
      sequence: 0,
      version: 1,
      instanceId: "",
      sessionFile: "",
      pid: 0,
      managed: false,
      model: "",
      thinking: "off",
      capabilities: [],
      idle: true,
      loop: false,
    })),
  );

  const error = ref("");
  const ready = ref(false);
  const revision = ref(0);
  const resumeAnchor = ref<{
    sessionId: string;
    key?: string;
    offset: number;
    top: number;
  }>();
  let suppressed = false;
  let syncing = false;
  let generation = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const channel =
    typeof window !== "undefined" && "BroadcastChannel" in window
      ? new BroadcastChannel("pi-remote-offline")
      : undefined;
  async function reload() {
    const expected = generation;
    try {
      const state = await library.read();
      if (expected !== generation) return;
      copies.value = state.copies;
      error.value = "";
    } catch {
      error.value = "Offline storage is unavailable on this phone.";
    }
    ready.value = true;
  }
  channel?.addEventListener("message", () => {
    generation++;
    suppressed = true;
    copies.value = [];
    void reload();
  });
  async function clear() {
    generation++;
    suppressed = true;
    copies.value = [];
    try {
      await library.clear();
      channel?.postMessage("clear");
    } catch {
      error.value = "Could not clear offline storage. Clear site data in your browser.";
    }
  }
  async function remove(ids: string[]) {
    generation++;
    copies.value = copies.value.filter((r) => !ids.includes(r.sessionId));
    try {
      await library.remove(ids);
      channel?.postMessage("purge");
    } catch {
      error.value = "Could not remove saved copies. Clear offline storage.";
    }
  }
  onUnpair(() => {
    void clear();
  });
  async function ticket() {
    if (suppressed) return undefined;
    try {
      return (await library.read()).epoch;
    } catch {
      return undefined;
    }
  }
  async function save(
    summary: OfflineSummary,
    messages: Message[],
    epoch: number | undefined,
    limited = false,
  ) {
    if (epoch === undefined || suppressed || !auth.unlocked) return;
    const expected = generation;
    try {
      const previous = copies.value.find((row) => row.sessionId === summary.sessionId);
      const incomingKeys = new Set(
        messages.map((m) => m.remoteHistoryKey).filter(Boolean),
      );
      if (
        previous?.messages.length &&
        !previous.messages.every((m) => incomingKeys.has(m.remoteHistoryKey))
      ) {
        const chunks: Message[][] = [[]];
        for (const message of previous.messages) {
          if (message.customType === "offline:gap") chunks.push([]);
          else chunks[chunks.length - 1]!.push(message);
        }
        const retained: Message[] = [];
        for (const chunk of chunks.slice(-8)) {
          const proof = await windowProof(chunk);
          if (!proof) continue;
          const check = await auth.request<HistoryPage>(
            `/sessions/${summary.sessionId}/history?window=latest${proof}`,
          );
          if (expected !== generation || suppressed || !auth.unlocked) return;
          if (!check.anchorFound) continue;
          if (retained.length)
            retained.push({
              role: "custom",
              customType: "offline:gap",
              display: true,
              content:
                "Some messages between these saved sections are unavailable offline.",
            });
          retained.push(...chunk);
        }
        const first = messages[0]?.remoteHistoryKey;
        const position =
          typeof first === "string"
            ? retained.findIndex((m) => m.remoteHistoryKey === first)
            : -1;
        if (position >= 0) messages = [...retained.slice(0, position), ...messages];
        else if (retained.length && messages.length)
          messages = [
            ...retained,
            {
              role: "custom",
              customType: "offline:gap",
              display: true,
              content:
                "Some messages between these saved sections are unavailable offline.",
            },
            ...messages,
          ];
      }
      if (expected !== generation || suppressed || !auth.unlocked) return;
      const state = await library.save(summary, messages, epoch, limited);
      if (expected === generation && !suppressed) copies.value = state.copies;
    } catch {
      if (expected === generation)
        error.value = "Could not save this conversation for offline reading.";
    }
  }

  async function synchronize() {
    if (syncing || suppressed || !auth.unlocked || !auth.online || !auth.visible)
      return;
    syncing = true;
    const expected = generation;
    try {
      const catalog = await auth.request<{
        sessions: OfflineSummary[];
        removed: string[];
      }>(
        `/offline-catalog?retained=${copies.value.map((row) => row.sessionId).join(",")}`,
      );
      if (
        expected !== generation ||
        suppressed ||
        !auth.unlocked ||
        !Array.isArray(catalog.sessions)
      )
        return;
      if (catalog.removed.length) {
        await remove(catalog.removed);
        return;
      }
      for (const summary of catalog.sessions) {
        if (expected !== generation || suppressed || !auth.unlocked || !auth.visible)
          break;
        const saved = copies.value.find((row) => row.sessionId === summary.sessionId);
        if (saved && saved.lastActivity >= summary.lastActivity) continue;
        const epoch = await ticket();
        try {
          const page = await auth.request<HistoryPage>(
            `/sessions/${summary.sessionId}/history?window=latest`,
          );
          if (
            expected !== generation ||
            suppressed ||
            !auth.unlocked ||
            !Array.isArray(page.messages)
          )
            break;
          await save(summary, page.messages, epoch, !!page.older || !!page.truncated);
        } catch (e) {
          if (e instanceof Error && e.message === "session_not_found")
            await remove([summary.sessionId]);
          if (!auth.online) break;
        }
      }
    } catch {
      /* Live use remains independent of offline synchronization. */
    } finally {
      syncing = false;
    }
  }
  function begin(startup = false) {
    if (active.value) return;
    if (deadline) return;
    const elapsed =
      startup && typeof performance !== "undefined" ? performance.now() : 0;
    deadline = setTimeout(
      () => {
        deadline = undefined;
        active.value = true;
      },
      Math.max(0, 10000 - elapsed),
    );
  }
  function complete() {
    if (deadline) clearTimeout(deadline);
    deadline = undefined;
    active.value = false;
  }
  function failed() {
    begin();
  }
  function requestRefresh() {
    revision.value++;
  }
  return {
    copies,
    sessions,
    active,
    error,
    ready,
    revision,
    resumeAnchor,
    reload,
    clear,
    remove,
    ticket,
    save,
    synchronize,
    begin,
    complete,
    failed,
    requestRefresh,
  };
});
