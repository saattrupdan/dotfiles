<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { useSessions } from "../stores/sessions.ts";
const store = useSessions();
const search = ref("");
const filter = ref("all");
const error = ref("");
onMounted(() => {
  store.connect("");
  void store.refresh().catch((e) => (error.value = e.message));
});
const filtered = computed(() =>
  store.sessions
    .filter(
      (s) =>
        (filter.value === "all" || s.state === filter.value) &&
        `${s.name} ${s.cwd} ${s.sessionId}`
          .toLowerCase()
          .includes(search.value.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(["idle", "running", "waiting"].includes(b.state)) -
          Number(["idle", "running", "waiting"].includes(a.state)) ||
        b.lastActivity - a.lastActivity,
    ),
);
</script>
<template>
  <section>
    <div class="row heading">
      <div>
        <p class="eyebrow">Your workspace, within reach</p>
        <h1>Conversations</h1>
      </div>
      <RouterLink
        to="/new"
        class="new"
        >+ New</RouterLink
      >
    </div>
    <input
      v-model="search"
      type="search"
      aria-label="Search conversations"
      placeholder="Search by name or project"
    /><select
      v-model="filter"
      aria-label="Filter state"
    >
      <option value="all">All conversations</option>
      <option
        v-for="state in ['running', 'idle', 'waiting', 'stopped', 'interrupted']"
        :key="state"
        :value="state"
      >
        {{ state }}
      </option>
    </select>
    <p
      v-if="error"
      class="error"
    >
      {{ error }}
    </p>
    <div class="list">
      <RouterLink
        v-for="session in filtered"
        :key="session.sessionId"
        :to="`/session/${session.sessionId}`"
        class="session"
        ><div class="row">
          <span :class="['dot', session.state]" /><span class="state">{{
            session.prompt?.state === "expired" ? "answer needed" : session.state
          }}</span
          ><span class="time">{{
            new Date(session.lastActivity).toLocaleDateString()
          }}</span>
        </div>
        <h2>{{ session.name || "Untitled conversation" }}</h2>
        <p class="path">{{ session.cwd }}</p></RouterLink
      >
      <div
        v-if="!filtered.length"
        class="empty card"
      >
        <h2>Room for a new idea.</h2>
        <p class="muted">Start a conversation here or open Pi on your Mac.</p>
      </div>
    </div>
  </section>
</template>
<style scoped>
.heading {
  justify-content: space-between;
}
.new {
  background: var(--accent);
  color: var(--bg);
  padding: 12px 18px;
  border-radius: 14px;
  text-decoration: none;
  font-weight: 700;
}
.list {
  display: grid;
  gap: 12px;
  margin-top: 22px;
}
.session {
  display: block;
  text-decoration: none;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 18px;
  padding: 20px;
}
.session:hover {
  border-color: var(--accent);
}
h2 {
  font-size: 19px;
  margin: 14px 0 8px;
}
.path {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--muted);
  margin: 0;
  overflow-wrap: anywhere;
}
.state {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.time {
  margin-left: auto;
  color: var(--muted);
  font-size: 11px;
}
.dot {
  height: 7px;
  width: 7px;
  border-radius: 50%;
  background: var(--muted);
}
.dot.running {
  background: var(--accent);
  box-shadow: 0 0 10px #a8e8cb55;
}
.dot.waiting {
  background: #f0cf84;
}
.empty {
  padding: 38px 22px;
}
</style>
