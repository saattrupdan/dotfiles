<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useAuth } from "../stores/auth.ts";
import { useSessions } from "../stores/sessions.ts";
import Transcript from "../components/Transcript.vue";
import type { Command } from "../../../../protocol/src/index.ts";
const route = useRoute();
const auth = useAuth();
const store = useSessions();
const id = computed(() => String(route.params.id));
const session = computed(() => store.sessions.find((s) => s.sessionId === id.value));
const question = computed(() => store.prompt[id.value] ?? session.value?.prompt);
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
async function load() {
  try {
    await store.refresh();
    await store.history(id.value);
    store.connect(id.value);
    name.value = session.value?.name ?? "";
    const parts = (session.value?.model ?? "").split("/");
    provider.value = parts.shift() ?? "";
    model.value = parts.join("/");
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);
watch(id, load);
watch(
  () => auth.visible,
  (value) => {
    if (value && auth.unlocked) void load();
  },
);
onUnmounted(() => {
  clearInterval(time);
  store.disconnect(true);
  previews.value.forEach(URL.revokeObjectURL);
});
async function action(command: Command) {
  error.value = "";
  try {
    await store.command(id.value, command);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function send() {
  if (!draft.value.trim() && !images.value.length) return;
  sending.value = true;
  const text = draft.value;
  const attached = [...images.value];
  draft.value = "";
  images.value = [];
  previews.value.forEach(URL.revokeObjectURL);
  previews.value = [];
  await action({ action: "message", text, images: attached });
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
async function recover() {
  try {
    await auth.request(`/sessions/${id.value}/recover`, { method: "POST", body: "{}" });
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>
<template>
  <section>
    <p class="eyebrow">{{ session?.state || "Saved conversation" }}</p>
    <h1>{{ session?.name || "Conversation" }}</h1>
    <p class="muted small">{{ session?.cwd }}</p>
    <div class="row">
      <button
        v-if="
          !session?.epoch ||
          ['stopped', 'interrupted', 'crashed'].includes(session.state)
        "
        class="primary"
        @click="recover"
      >
        Recover on Mac</button
      ><button
        v-else
        class="danger"
        @click="action({ action: 'stop_run' })"
      >
        Stop run
      </button>
      <details>
        <summary class="quiet">Controls</summary>
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
      v-if="error"
      class="error"
      role="alert"
    >
      {{ error }}
    </p>
    <Transcript
      :messages="store.messages[id] || []"
      :streaming="store.streaming[id]"
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
        v-for="(status, commandId) in store.statuses"
        :key="commandId"
        class="small muted"
      >
        {{ String(commandId).slice(0, 8) }}: {{ status.replaceAll("_", " ")
        }}<span v-if="status === 'delivery_unknown'"
          >. Check the conversation before explicitly retrying; retrying may duplicate
          work.</span
        >
      </p>
    </div>
    <div class="composer">
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
        <p class="eyebrow">Pi needs your answer</p>
        <h3 id="active-question">{{ question.title }}</h3>
        <p class="muted small">
          {{ Math.max(0, Math.ceil((question.deadline - now) / 60000)) }} minutes
          remaining
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
          placeholder="Message Pi..."
          aria-label="Message Pi"
        />
        <div class="row">
          <label class="image-button"
            >+ Image<input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
              multiple
              @change="upload" /></label
          ><button
            class="primary"
            :disabled="sending || !session?.epoch"
            type="submit"
          >
            {{
              sending
                ? "Sending..."
                : session?.state === "running"
                  ? "Steer Pi"
                  : "Send"
            }}
          </button>
        </div>
        <p class="small muted">
          Drafts stay in memory and disappear when the app closes or locks.
        </p>
      </form>
    </div>
  </section>
</template>
<style scoped>
h1 {
  font-size: 27px;
  margin-bottom: 10px;
}
.composer {
  position: sticky;
  bottom: 0;
  max-height: calc(100dvh - env(safe-area-inset-top) - 24px);
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--bg);
  border-top: 1px solid var(--line);
  padding: 14px 0 max(8px, env(safe-area-inset-bottom));
}
.composer .row {
  justify-content: space-between;
}
.image-button {
  border: 1px solid var(--line);
  border-radius: 12px;
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
  border-top: 1px solid var(--line);
}
</style>
