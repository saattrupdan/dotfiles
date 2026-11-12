<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useAuth } from "../stores/auth.ts";
import { useSessions } from "../stores/sessions.ts";
import Transcript from "../components/Transcript.vue";
import LoadingIndicator from "../components/LoadingIndicator.vue";
import { isUntitled } from "../lib/conversation-name.ts";
import Icon from "../components/Icon.vue";
import { remoteCommandId, receiptLabel } from "../lib/receipts.ts";
import type { Command } from "../../../../protocol/src/index.ts";
const toolsExpanded = ref(false),
  thinkingExpanded = ref(false);
let disposed = false;
const content = ref<HTMLElement>();
const composer = ref<HTMLElement>();
const composerHeight = ref(80);
let scrollFrame: number | undefined;
let resize: ResizeObserver | undefined;
const route = useRoute();
const auth = useAuth();
const store = useSessions();
const id = computed(() => String(route.params.id));
const session = computed(() => store.sessions.find((s) => s.sessionId === id.value));
const question = computed(() => store.prompt[id.value] ?? session.value?.prompt);
const recoveryReason = computed(
  () =>
    session.value?.controlBlockedReason ??
    {
      laptop_restart_required:
        "Exit all pre-update Pi sessions on your laptop, then reopen Pi once.",
      laptop_activation_required: "Enable laptop phone control on your Mac to connect.",
      owner_not_connected:
        "Pi is still open on your laptop. Waiting for it to reconnect.",
      ambiguous_session_id:
        "This history has a duplicate session ID. Resolve it on your laptop.",
    }[session.value?.recoveryBlockedReason ?? ""],
);
const outgoing = computed(() =>
  Object.entries(store.outgoing).filter(
    ([commandId, message]) =>
      message.sessionId === id.value &&
      !(store.messages[id.value] ?? []).some(
        (native) => remoteCommandId(native) === commandId,
      ),
  ),
);
const warnings = computed(() =>
  Object.entries(store.statuses).filter(
    ([commandId, status]) =>
      store.commandSessions[commandId] === id.value &&
      ["delivery_unknown", "rejected"].includes(status),
  ),
);
const error = ref("");
const sending = ref(false);
const acting = ref(false);
const uploading = ref(false);
const loadError = ref("");
const images = ref<string[]>([]);
const previews = ref<string[]>([]);
const answer = ref("");
const multi = ref<string[]>([]);
const provider = ref("");
const model = ref("");
const slash = ref("");
const args = ref("");
const name = ref("");
const now = ref(Date.now());
const draft = computed({
  get: () => store.drafts[id.value] ?? "",
  set: (value) => (store.drafts[id.value] = value),
});
watch(
  () => question.value?.id,
  () => {
    answer.value = "";
    multi.value = [];
  },
);
const time = setInterval(() => (now.value = Date.now()), 1000);
let following = true;
const opening = ref(true);
const paging = ref(false);
let pagingOperation = 0;
const page = computed(() => store.historyPages[id.value]);
let upwardIntent = false;
let lastScroll = 0;
let lastHeight = 0;
let touchY = 0;
type Anchor = { key: string; offset: number };
let heldAnchor: Anchor | undefined;
let prependAnchor: Anchor | undefined;
function captureAnchor(): Anchor | undefined {
  const rows = content.value?.querySelectorAll<HTMLElement>("[data-history-row]");
  for (const row of rows ?? []) {
    const box = row.getBoundingClientRect();
    if (box.height > 0 && box.bottom > 130 && box.top < window.innerHeight)
      return { key: row.dataset.historyRow!, offset: box.top };
  }
}
function restoreAnchor(anchor?: Anchor) {
  if (!anchor) return;
  const row = [
    ...(content.value?.querySelectorAll<HTMLElement>("[data-history-row]") ?? []),
  ].find((row) => row.dataset.historyRow === anchor.key);
  if (row)
    window.scrollBy({
      top: row.getBoundingClientRect().top - anchor.offset,
      behavior: "instant",
    });
}
async function older() {
  if (
    paging.value ||
    opening.value ||
    !page.value?.older ||
    !auth.unlocked ||
    !auth.visible
  )
    return;
  const target = id.value;
  const expected = loadGeneration;
  const operation = ++pagingOperation;
  paging.value = true;
  prependAnchor = undefined;
  try {
    await store.loadOlder(target);
    await nextTick();
    if (!disposed && expected === loadGeneration && target === id.value) {
      restoreAnchor(prependAnchor);
      heldAnchor = captureAnchor();
    }
  } catch (e) {
    if (!disposed) error.value = (e as Error).message;
  } finally {
    if (operation === pagingOperation) paging.value = false;
  }
  requestAnimationFrame(() => {
    if (!disposed && target === id.value) maybeOlder();
  });
}
function maybeOlder() {
  if (upwardIntent && window.scrollY < window.innerHeight * 1.5 && !page.value?.error)
    void older();
}
watch(
  () => store.messages[id.value],
  (next, previous) => {
    if (paging.value && previous?.length && next?.[0] !== previous[0])
      prependAnchor = captureAnchor();
  },
  { flush: "pre" },
);
const composerInput = ref<HTMLTextAreaElement>();
let automaticUntil = 0;
let loadGeneration = 0;
function nearBottom() {
  return (
    document.documentElement.scrollHeight - window.innerHeight - window.scrollY < 80
  );
}
function stopFollowing() {
  following = false;
  automaticUntil = 0;
  smoothPending = false;
  if (scrollFrame !== undefined) {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = undefined;
  }
}
function userScroll(event?: Event) {
  if (event?.target instanceof Element && event.target.closest(".composer")) return;
  automaticUntil = 0;
  heldAnchor = undefined;
  if (event?.type === "wheel" && (!(event instanceof WheelEvent) || event.deltaY < 0)) {
    stopFollowing();
    upwardIntent = true;
    maybeOlder();
  }
  if (
    typeof TouchEvent !== "undefined" &&
    event instanceof TouchEvent &&
    event.touches[0]
  )
    touchY = event.touches[0].clientY;
}
function touchMoved(event: TouchEvent) {
  if (event.target instanceof Element && event.target.closest(".composer")) return;
  if (event.touches[0] && event.touches[0].clientY - touchY > 8) {
    stopFollowing();
    upwardIntent = true;
    maybeOlder();
  }
}
function keyScrolled(event: KeyboardEvent) {
  if (
    !["ArrowUp", "PageUp", "Home"].includes(event.key) ||
    (event.target instanceof Element &&
      event.target.closest("input,textarea,select,[contenteditable=true]"))
  )
    return;
  stopFollowing();
  upwardIntent = true;
  maybeOlder();
}
function scrolled() {
  const height = document.documentElement.scrollHeight;
  // Layout-driven scroll events must not replace the reader's anchor.
  const layoutChanged = height !== lastHeight;
  const moved = Math.abs(window.scrollY - lastScroll) > 2;
  lastScroll = window.scrollY;
  lastHeight = height;
  if (!paging.value && nearBottom()) {
    following = true;
    upwardIntent = false;
    heldAnchor = undefined;
    // Focus and layout shifts are not reader gestures.
  } else if (
    upwardIntent &&
    Date.now() >= automaticUntil &&
    !paging.value &&
    !layoutChanged &&
    moved
  ) {
    following = false;
    heldAnchor = captureAnchor();
  }
  maybeOlder();
}
let smoothPending = false;
function scrollBottom(smooth = false) {
  if (paging.value || !auth.unlocked || !auth.visible || (!opening.value && !following))
    return;
  if (opening.value) smoothPending = false;
  else smoothPending ||= smooth;
  if (scrollFrame !== undefined) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = undefined;
    if (
      disposed ||
      paging.value ||
      !auth.unlocked ||
      !auth.visible ||
      (!opening.value && !following)
    )
      return;
    const animate =
      smoothPending &&
      !opening.value &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    smoothPending = false;
    automaticUntil = Date.now() + (animate ? 700 : 0);
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: animate ? "smooth" : "instant",
    });
  });
}
watch(
  () => [store.messages[id.value], store.streaming[id.value], store.outgoing],
  () => scrollBottom(true),
  { deep: true, flush: "post" },
);
async function load(initial = true) {
  const expected = ++loadGeneration;
  const target = id.value;
  if (initial) {
    pagingOperation++;
    paging.value = false;
    opening.value = true;
    following = true;
    upwardIntent = false;
    heldAnchor = undefined;
    loadError.value = "";
  }
  try {
    await store.detail(target);
    await store.history(target, initial);
    if (disposed || expected !== loadGeneration || target !== id.value) return;
    store.connect(target);
    name.value = isUntitled(session.value?.name) ? "" : (session.value?.name ?? "");
    const parts = (session.value?.model ?? "").split("/");
    provider.value = parts.shift() ?? "";
    model.value = parts.join("/");
    await nextTick();
    scrollBottom();
    requestAnimationFrame(() => {
      if (!disposed && expected === loadGeneration) opening.value = false;
    });
  } catch (e) {
    if (!disposed && expected === loadGeneration)
      loadError.value = (e as Error).message;
    if (expected === loadGeneration) opening.value = false;
  }
}
onMounted(() => {
  resize = new ResizeObserver(() => {
    if (composer.value)
      composerHeight.value = composer.value.getBoundingClientRect().height;
    if (paging.value) return;
    if (!following) restoreAnchor(heldAnchor);
    else scrollBottom();
  });
  if (content.value) resize.observe(content.value);
  if (composer.value) resize.observe(composer.value);
  window.addEventListener("scroll", scrolled, { passive: true });
  window.addEventListener("wheel", userScroll, { passive: true });
  window.addEventListener("keydown", keyScrolled);
  window.addEventListener("touchstart", userScroll, { passive: true });
  window.addEventListener("touchmove", touchMoved, { passive: true });
  window.addEventListener("resize", resized);
  window.visualViewport?.addEventListener("resize", resized);
  void load();
});
watch(id, () => void load());
watch(
  () => auth.visible,
  (value) => {
    if (value && auth.unlocked) void load(false);
  },
);
onUnmounted(() => {
  disposed = true;
  loadGeneration++;
  clearInterval(time);
  resize?.disconnect();
  window.removeEventListener("scroll", scrolled);
  window.removeEventListener("wheel", userScroll);
  window.removeEventListener("keydown", keyScrolled);
  window.removeEventListener("touchstart", userScroll);
  window.removeEventListener("touchmove", touchMoved);
  window.removeEventListener("resize", resized);
  window.visualViewport?.removeEventListener("resize", resized);
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
  store.disconnect(true);
  previews.value.forEach(URL.revokeObjectURL);
});
function resized() {
  scrollBottom();
}
watch(draft, (value) => {
  if (!value && composerInput.value) composerInput.value.style.height = "auto";
});
function growComposer(event: Event) {
  const input = event.target as HTMLTextAreaElement;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}
async function action(command: Command) {
  if (acting.value) return;
  if (recoveryReason.value) {
    error.value = recoveryReason.value;
    return;
  }
  error.value = "";
  acting.value = true;
  try {
    return await store.command(id.value, command);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    acting.value = false;
  }
}
async function send() {
  if (sending.value || uploading.value || acting.value || opening.value) return;
  if (recoveryReason.value) {
    error.value = recoveryReason.value;
    return;
  }
  if (!draft.value.trim() && !images.value.length) return;
  sending.value = true;
  const target = id.value;
  const text = draft.value;
  const attached = [...images.value];
  try {
    await store.ensureOwner(target);
    if (disposed || id.value !== target || !auth.unlocked || !auth.visible) {
      sending.value = false;
      return;
    }
  } catch (e) {
    error.value = (e as Error).message;
    sending.value = false;
    return;
  }
  draft.value = "";
  images.value = [];
  const urls = previews.value;
  previews.value = [];
  const sent = await action({ action: "message", text, images: attached });
  if (
    !sent &&
    !Object.values(store.pending).some(
      (entry) =>
        entry.sessionId === target &&
        entry.text === text &&
        JSON.stringify(entry.images) === JSON.stringify(attached),
    ) &&
    !disposed &&
    id.value === target &&
    auth.unlocked
  ) {
    draft.value = text;
    images.value = attached;
    previews.value = urls;
  } else urls.forEach(URL.revokeObjectURL);
  sending.value = false;
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  if (uploading.value) return;
  uploading.value = true;
  const target = id.value;
  error.value = "";
  try {
    for (const file of Array.from(input.files ?? [])) {
      try {
        const form = new FormData();
        form.append("image", file);
        const result = await auth.request<{ id: string }>(
          `/uploads?sessionId=${target}`,
          { method: "POST", body: form },
        );
        if (disposed || !auth.unlocked || id.value !== target) return;
        images.value.push(result.id);
        previews.value.push(URL.createObjectURL(file));
      } catch (e) {
        if (!disposed && auth.unlocked && id.value === target)
          error.value = (e as Error).message;
      }
    }
  } finally {
    uploading.value = false;
    input.value = "";
  }
}
</script>
<template>
  <section
    ref="content"
    class="conversation"
    :aria-busy="opening"
    :class="{ positioning: opening }"
    :style="{ '--composer-height': `${composerHeight}px` }"
  >
    <div
      v-if="opening"
      class="opening-indicator"
    >
      <LoadingIndicator label="Opening conversation" />
    </div>
    <div
      v-if="loadError"
      class="card"
      role="alert"
    >
      <p>{{ loadError }}</p>
      <button @click="load()">Try again</button>
    </div>
    <h1 class="sr-only">
      {{
        isUntitled(session?.name) ? "New conversation" : session?.name || "Conversation"
      }}
    </h1>
    <LoadingIndicator
      v-if="acting && !sending"
      label="Applying change"
    />
    <div class="row conversation-toolbar">
      <button
        class="icon-button"
        :aria-label="toolsExpanded ? 'Collapse tool outputs' : 'Expand tool outputs'"
        title="Tool outputs"
        :aria-pressed="toolsExpanded"
        @click="toolsExpanded = !toolsExpanded"
      >
        <Icon name="tools" />
      </button>
      <button
        class="icon-button"
        :aria-label="thinkingExpanded ? 'Collapse reasoning' : 'Expand reasoning'"
        title="Reasoning"
        :aria-pressed="thinkingExpanded"
        @click="thinkingExpanded = !thinkingExpanded"
      >
        <Icon name="brain" />
      </button>
      <button
        v-if="session?.state === 'running'"
        class="icon-button danger"
        :disabled="acting || opening || Boolean(recoveryReason)"
        aria-label="Stop run"
        title="Stop run"
        @click="action({ action: 'stop_run' })"
      >
        <Icon name="stop" />
      </button>
      <details class="conversation-settings">
        <summary
          class="icon-button"
          aria-label="Conversation settings"
          title="Conversation settings"
        >
          <Icon name="sliders" /><span class="sr-only">Conversation settings</span>
        </summary>
        <fieldset
          class="card"
          :disabled="acting || opening"
        >
          <label>Name<input v-model="name" /></label
          ><button @click="action({ action: 'rename', name })">Rename</button
          ><label>Provider<input v-model="provider" /></label
          ><label>Model<input v-model="model" /></label
          ><button @click="action({ action: 'model', provider, model })">
            Set model</button
          ><label
            >Thinking<select
              :value="session?.thinking"
              @change="
                action({
                  action: 'thinking',
                  level: ($event.target as HTMLSelectElement).value as 'off',
                })
              "
            >
              <option
                v-for="level in ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']"
                :key="level"
              >
                {{ level }}
              </option>
            </select></label
          >
          <div class="row">
            <button @click="action({ action: 'compact' })">Compact</button
            ><button
              class="danger"
              @click="action({ action: 'stop_session' })"
            >
              Stop session
            </button>
          </div>
          <label
            >Command<select v-model="slash">
              <option value="">Choose a command</option>
              <option
                v-for="command in session?.capabilities"
                :key="command.name"
                :value="command.name"
                :disabled="!command.supported"
              >
                /{{ command.name }}{{ command.supported ? "" : ` - ${command.reason}` }}
              </option>
            </select></label
          ><input
            v-model="args"
            placeholder="Command arguments"
          /><button
            :disabled="!slash || !args.trim()"
            @click="action({ action: 'slash', name: slash, args })"
          >
            Run command
          </button>
        </fieldset>
      </details>
    </div>
    <p
      v-if="recoveryReason"
      class="small muted"
      role="status"
    >
      {{ recoveryReason }}
    </p>
    <p
      v-if="store.historyLimited[id]"
      class="small muted"
      role="status"
    >
      Showing the latest saved messages from this large conversation.
    </p>
    <div
      v-if="page?.older || page?.loading || page?.error"
      class="older-history"
    >
      <LoadingIndicator
        v-if="paging || page.loading"
        label="Loading earlier messages"
        compact
      />
      <button
        v-else
        @click="older"
      >
        {{
          page.error ? "Try loading earlier messages again" : "Load earlier messages"
        }}
      </button>
      <p
        v-if="page.error"
        class="error small"
        role="alert"
      >
        {{ page.error }}
      </p>
    </div>
    <Transcript
      :messages="store.messages[id] || []"
      :streaming="store.streaming[id]"
      :tool-progress="store.toolProgress[id]"
      :tools-expanded="toolsExpanded"
      :thinking-expanded="thinkingExpanded"
      :statuses="store.statuses"
    />
    <article
      v-for="[commandId, pending] in outgoing"
      :key="commandId"
      class="outgoing-message"
    >
      <p>{{ pending.text }}</p>
      <p
        v-if="pending.images.length"
        class="small muted"
      >
        {{ pending.images.length }} photo(s)
      </p>
      <span
        class="receipt"
        role="status"
        :aria-label="
          receiptLabel(pending.status === 'persisted' ? 'received' : pending.status)
        "
        :title="
          receiptLabel(pending.status === 'persisted' ? 'received' : pending.status)
        "
      >
        <span v-if="['rejected', 'delivery_unknown'].includes(pending.status)">!</span>
        <Icon
          v-else
          :name="pending.status === 'persisted' ? 'check' : 'spinner'"
        />
      </span>
    </article>
    <div
      v-for="[commandId, status] in warnings"
      :key="commandId"
      class="send-warning"
      role="status"
    >
      <p class="small error">
        {{
          status === "delivery_unknown"
            ? "Delivery unknown"
            : "Message or command rejected"
        }}
        <span v-if="status === 'delivery_unknown'"
          >. Check the conversation before retrying; another submission may duplicate
          work.</span
        >
      </p>
      <button
        v-if="status === 'delivery_unknown' && store.pending[commandId]"
        @click="
          store
            .command(id, store.pending[commandId]!.command, commandId)
            .catch((e) => (error = e.message))
        "
      >
        Explicitly retry
      </button>
    </div>
    <div
      ref="composer"
      class="composer"
    >
      <div
        v-if="session?.workingMessage"
        class="working-status"
        role="status"
        aria-live="polite"
      >
        <Icon name="spinner" /><span>{{ session.workingMessage }}</span>
      </div>
      <p
        v-if="error"
        class="error"
        role="alert"
      >
        {{ error }}
      </p>

      <form
        v-if="question?.state === 'pending'"
        class="question card"
        aria-labelledby="active-question"
        @submit.prevent="
          action({
            action: 'answer',
            promptId: question.id,
            answer: question.multiSelect ? multi : answer,
          })
        "
      >
        <h3 id="active-question">{{ question.title }}</h3>
        <p class="muted small">
          {{ Math.max(0, Math.ceil((question.deadline - now) / 60000)) }}m left
        </p>
        <template v-if="question.multiSelect">
          <label
            v-for="option in question.options"
            :key="option"
            ><input
              v-model="multi"
              type="checkbox"
              :value="option"
            />{{ option }}</label
          ><button
            class="primary"
            type="submit"
            :disabled="Boolean(recoveryReason) || !multi.length"
          >
            Submit selections
          </button> </template
        ><template v-else>
          <div class="choices">
            <button
              v-for="option in question.options"
              :key="option"
              type="button"
              @click="
                action({ action: 'answer', promptId: question.id, answer: option })
              "
            >
              {{ option }}
            </button>
          </div>
          <input
            v-model="answer"
            placeholder="Type an answer"
            aria-label="Answer Pi"
          /><button
            class="primary"
            type="submit"
            :disabled="Boolean(recoveryReason) || !answer.trim()"
          >
            Answer
          </button>
        </template>
      </form>
      <div
        v-else-if="question?.state === 'expired'"
        class="question card"
      >
        <h3>Answer needed</h3>
        <p>{{ question.title }}</p>
        <p class="muted">
          The run stopped after 30 minutes. Send your answer as a new message to
          continue.
        </p>
      </div>
      <form
        v-if="question?.state !== 'pending'"
        class="message-form"
        @submit.prevent="send"
      >
        <div class="previews">
          <img
            v-for="preview in previews"
            :key="preview"
            :src="preview"
            alt="Image to attach"
          />
        </div>
        <textarea
          ref="composerInput"
          v-model="draft"
          :readonly="sending"
          placeholder="Message"
          rows="1"
          aria-label="Message Pi"
          @input="growComposer"
        />
        <div class="row">
          <label
            class="image-button icon-button"
            aria-label="Attach image"
            title="Attach image"
            ><Icon :name="uploading ? 'spinner' : 'image'" /><input
              type="file"
              :disabled="sending || uploading"
              accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
              multiple
              @change="upload" /></label
          ><button
            class="primary icon-button"
            aria-label="Send message"
            title="Send message"
            :disabled="
              sending ||
              acting ||
              uploading ||
              opening ||
              Boolean(recoveryReason) ||
              (!draft.trim() && !images.length)
            "
            type="submit"
          >
            <Icon :name="sending ? 'spinner' : 'send'" />
          </button>
        </div>
      </form>
    </div>
  </section>
</template>
<style scoped>
.working-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 13px;
  padding: 4px 6px 10px;
}
.working-status :deep(svg) {
  width: 16px;
  height: 16px;
  color: var(--accent);
}

.conversation {
  overflow-anchor: none;
  display: flex;
  flex-direction: column;
  min-height: calc(100dvh - var(--header-height) - env(safe-area-inset-top));
}
.older-history {
  min-height: 44px;
  display: grid;
  place-items: center;
  margin: 12px 0;
}
.older-history button {
  border: 0;
  color: var(--muted);
  font-size: 13px;
}
.opening-indicator {
  position: fixed;
  inset: calc(var(--header-height) + env(safe-area-inset-top)) 0 var(--composer-height);
  display: grid;
  place-content: center;
  pointer-events: none;
  z-index: 30;
}
.conversation-settings fieldset {
  min-width: 0;
  margin: 0;
}
.conversation-toolbar {
  position: sticky;
  top: calc(var(--header-height) + env(safe-area-inset-top));
  z-index: 25;
  background: var(--bg);
  padding: 2px 0;
  border-bottom: 1px solid var(--line);
}
.conversation-toolbar [aria-pressed="true"] {
  color: var(--accent);
  background: var(--panel);
}
.conversation-settings {
  margin-left: auto;
  position: relative;
}
.conversation-settings > summary {
  list-style: none;
}
.conversation-settings > summary::-webkit-details-marker {
  display: none;
}
.conversation-settings > .card {
  position: absolute;
  right: 0;
  width: min(360px, 85vw);
  max-height: 65dvh;
  overflow: auto;
  z-index: 26;
  background: var(--bg);
  box-shadow: 0 10px 40px #0008;
}
h1 {
  font-size: 25px;
  margin-bottom: 8px;
}
.composer {
  flex-shrink: 0;
  margin-top: auto;
  position: sticky;
  bottom: 0;
  max-height: calc(100dvh - env(safe-area-inset-top) - 132px);
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--bg);
  padding: 8px 0 max(8px, env(safe-area-inset-bottom));
}
.composer .row {
  justify-content: space-between;
}
.image-button {
  border: 0;
  border-radius: 50%;
  padding: 10px;
  color: var(--accent);
  cursor: pointer;
}
.image-button input {
  display: none;
}
.previews {
  display: flex;
  gap: 8px;
}
.previews img {
  width: 65px;
  height: 65px;
  object-fit: cover;
}
.choices {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.question {
  margin: 0;
  border-color: var(--accent);
}
.question input[type="checkbox"] {
  display: inline;
  width: auto;
  margin-right: 10px;
}
.composer textarea {
  border: 0;
  padding: 12px 14px;
  background: var(--panel);
  border-radius: 24px;
  resize: none;
  min-height: 48px;
  max-height: 140px;
  margin: 0;
}
.image-button {
  min-height: 44px;
  margin: 0;
}
.question h3 {
  margin: 0;
  font-size: 17px;
}
.message-form {
  display: grid;
  grid-template-columns: 44px 1fr 48px;
  gap: 6px;
  align-items: end;
}
.message-form > .row {
  display: contents;
}
.message-form > textarea {
  grid-column: 2;
  grid-row: 2;
}
.message-form .image-button {
  grid-column: 1;
  grid-row: 2;
}
.message-form button[type="submit"] {
  grid-column: 3;
  grid-row: 2;
  border-radius: 50%;
  width: 48px;
  height: 48px;
}
.previews {
  grid-column: 1 / -1;
}
.outgoing-message {
  background: var(--outgoing);
  margin: 8px 0 8px auto;
  padding: 10px 12px 6px;
  border-radius: 14px 14px 3px 14px;
  max-width: 88%;
  width: fit-content;
  overflow-wrap: anywhere;
}
.outgoing-message > p {
  margin: 0;
  white-space: pre-wrap;
}
.receipt {
  display: flex;
  justify-content: end;
  color: var(--muted);
  margin-top: 4px;
}
.receipt :deep(svg) {
  width: 16px;
  height: 16px;
}
.send-warning {
  margin: 12px 0;
}
.positioning :deep(.transcript),
.positioning .outgoing-message {
  visibility: hidden;
}
</style>
