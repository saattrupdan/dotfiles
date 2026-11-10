<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useAuth } from "../stores/auth.ts";
import { useSessions } from "../stores/sessions.ts";
import Transcript from "../components/Transcript.vue";
import Icon from "../components/Icon.vue";
import type { Command } from "../../../../protocol/src/index.ts";
const toolsExpanded = ref(false),
  thinkingExpanded = ref(false);
let disposed = false;
const content = ref<HTMLElement>();
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
    ({
      laptop_restart_required:
        "Exit all pre-update Pi sessions on your laptop, then reopen Pi once.",
      laptop_activation_required: "Enable laptop phone control on your Mac to connect.",
      owner_not_connected:
        "Pi is still open on your laptop. Waiting for it to reconnect.",
      ambiguous_session_id:
        "This history has a duplicate session ID. Resolve it on your laptop.",
    })[session.value?.recoveryBlockedReason ?? ""],
);
const delivery = computed(() => {
  const warnings: [string, string][] = [];
  const details: [string, string][] = [];
  for (const entry of Object.entries(store.statuses)) {
    (["delivery_unknown", "rejected"].includes(entry[1]) ? warnings : details).push(
      entry,
    );
  }
  return { warnings, details };
});
const error = ref("");
const sending = ref(false);
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
function scrollBottom() {
  if (!auth.unlocked || !auth.visible) return;
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  });
}
watch(() => [store.messages[id.value], store.streaming[id.value]], scrollBottom, {
  deep: true,
  flush: "post",
});
async function load() {
  try {
    await store.detail(id.value);
    await store.history(id.value);
    store.connect(id.value);
    name.value = session.value?.name ?? "";
    const parts = (session.value?.model ?? "").split("/");
    provider.value = parts.shift() ?? "";
    model.value = parts.join("/");
    await nextTick();
    scrollBottom();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(() => {
  resize = new ResizeObserver(scrollBottom);
  if (content.value) resize.observe(content.value);
  void load();
});
watch(id, load);
watch(
  () => auth.visible,
  (value) => {
    if (value && auth.unlocked) void load();
  },
);
onUnmounted(() => {
  disposed = true;
  clearInterval(time);
  resize?.disconnect();
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
  store.disconnect(true);
  previews.value.forEach(URL.revokeObjectURL);
});
async function action(command: Command) {
  if (recoveryReason.value) {
    error.value = recoveryReason.value;
    return;
  }
  error.value = "";
  try {
    return await store.command(id.value, command);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function send() {
  if (sending.value) return;
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
  error.value = "";
  for (const file of Array.from(input.files ?? [])) {
    try {
      const form = new FormData();
      form.append("image", file);
      const result = await auth.request<{ id: string }>(
        `/uploads?sessionId=${id.value}`,
        { method: "POST", body: form },
      );
      images.value.push(result.id);
      previews.value.push(URL.createObjectURL(file));
    } catch (e) {
      error.value = (e as Error).message;
    }
  }
  input.value = "";
}
</script>
<template>
  <section ref="content">
    <p class="small muted session-state">{{ session?.state || "Saved" }}</p>
    <h1>{{ session?.name || "Conversation" }}</h1>
    <p class="muted small">{{ session?.cwd }}</p>
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
        :disabled="Boolean(recoveryReason)"
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
        <div class="card">
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
        </div>
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
    <Transcript
      :messages="store.messages[id] || []"
      :streaming="store.streaming[id]"
      :tools-expanded="toolsExpanded"
      :thinking-expanded="thinkingExpanded"
    />
    <div
      v-for="(pending, pendingId) in Object.fromEntries(
        Object.entries(store.pending).filter(([, message]) => message.sessionId === id),
      )"
      :key="pendingId"
      class="card"
    >
      <p>{{ pending.text }}</p>
      <p class="small muted">
        {{ pending.images.length ? `${pending.images.length} image(s). ` : ""
        }}{{ pending.status.replaceAll("_", " ") }}
      </p>
      <template v-if="pending.status === 'delivery_unknown'">
        <p class="small">
          Check the conversation before retrying. Another submission may duplicate work.
        </p>
        <button
          @click="
            store
              .command(id, pending.command, String(pendingId))
              .catch((e) => (error = e.message))
          "
        >
          Explicitly retry
        </button>
      </template>
    </div>
    <div class="delivery">
      <p
        v-for="[commandId, status] in delivery.warnings"
        :key="commandId"
        class="small error"
        role="status"
      >
        {{ commandId.slice(0, 8) }}: {{ status.replaceAll("_", " ")
        }}<span v-if="status === 'delivery_unknown'"
          >. Check the conversation before explicitly retrying; retrying may duplicate
          work.</span
        >
      </p>
      <details v-if="delivery.details.length">
        <summary class="small muted">Delivery</summary>
        <p
          v-for="[commandId, status] in delivery.details"
          :key="commandId"
          class="small muted"
        >
          {{ commandId.slice(0, 8) }}: {{ status.replaceAll("_", " ") }}
        </p>
      </details>
    </div>
    <div class="composer">
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
            :disabled="!multi.length"
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
            :disabled="!answer.trim()"
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
          v-model="draft"
          :readonly="sending"
          placeholder="Message Pi..."
          aria-label="Message Pi"
        />
        <div class="row">
          <label
            class="image-button icon-button"
            aria-label="Attach image"
            title="Attach image"
            ><Icon name="image" /><input
              type="file"
              :disabled="sending"
              accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
              multiple
              @change="upload" /></label
          ><button
            class="primary icon-button"
            aria-label="Send message"
            title="Send message"
            :disabled="
              sending || Boolean(recoveryReason) || (!draft.trim() && !images.length)
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
.conversation-toolbar {
  position: sticky;
  top: calc(76px + env(safe-area-inset-top));
  z-index: 25;
  background: var(--bg);
  padding: 4px 0;
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
  position: sticky;
  bottom: 0;
  max-height: calc(100dvh - env(safe-area-inset-top) - 132px);
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--bg);
  border-top: 1px solid var(--line);
  padding: 12px 0 max(8px, env(safe-area-inset-bottom));
}
.composer .row {
  justify-content: space-between;
}
.image-button {
  border: 1px solid var(--line);
  border-radius: 10px;
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
.delivery {
  margin-top: 12px;
}
.session-state {
  margin: 0 0 8px;
}
.composer textarea {
  border: 0;
  padding: 10px 0;
  background: none;
}
.image-button {
  min-height: 44px;
  margin: 10px 0;
}
.question h3 {
  margin: 0;
  font-size: 17px;
}
</style>
