import { createApp } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import Toast from "vue-toastification";
import "vue-toastification/dist/index.css";
import App from "./App.vue";
import Sessions from "./views/Sessions.vue";
import Conversation from "./views/Conversation.vue";
import NewSession from "./views/NewSession.vue";
import Settings from "./views/Settings.vue";
import "./assets/main.css";
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: Sessions },
    { path: "/session/:id", component: Conversation },
    { path: "/new", component: NewSession },
    { path: "/settings", component: Settings },
    { path: "/pair", component: Sessions },
  ],
});
createApp(App)
  .use(createPinia())
  .use(router)
  .use(Toast, { timeout: 4000 })
  .mount("#app");
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
