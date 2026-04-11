---
name: vue
description: Conventions when coding in Vue.js. Use whenever you're building a frontend.
license: MIT
compatibility: opencode
metadata:
  triggers: vue, vuejs, vue.js, frontend
---

## Vue.js Conventions

### Natural Language

- Write in British English, never American English. This also holds for comments,
  docstrings and other documentation.

### Code Organisation

- Keep modules focused and cohesive
- Prefer many small modules over few large ones
- All frontend code is in the `src/frontend/` directory.
- Use the `tree -a --gitignore -I .git .` command to see the directory structure
- Aim for the following overall structure:
  ```bash
  index.html
  vite.config.ts
  tsconfig.json
  package.json
  eslint.config.js
  .prettier.config.js
  makefile
  src/frontend/
  ├── App.vue
  ├── main.ts
  ├── vite-env.d.ts
  ├── views/
  │   ├── ...
  ├── components/
  │   ├── ...
  ├── routes/
  │   ├── index.ts
  │   ├── ...
  ├── stores/
  │   ├── ...
  ├── types/
  │   ├── ...
  ├── assets/
  │   ├── main.css
  │   ├── ...
  └── ...
  ```

### Code Quality

#### Quality Checkers

- We use Prettier for formatting, ESLint for linting and vue-tsc for type checking
- Ensure that there is a `check` script in `package.json`, defined as:
  ```json
  vue-tsc --noEmit && eslint src/frontend --ext .vue,.js,.jsx,.cjs,.mjs,.ts,.tsx,.cts,.mts --fix
  ```
- Ensure that the `makefile` has a `check` recipe that includes `npm run check`
- Ensure that the checks pass

#### General Code Conventions

- Code should always fit within 88 characters
- All `vue` files should contain `<script>`, `<template>` and `<style>` tags, in that
  order
- All script tags should be typescript: `<script setup lang="ts">`
- All style tags should be scoped: `<style scoped>`
- All imports should happen at the top of each file
- Use regular CSS, no UI frameworks such as Tailwind

### Standard packages

- Use `vue-router` for routing
- Use `pinia` for state management
- Use `vue-toastification` for toast notifications
- Use `vue3-spinners` for spinners

### Documentation

- Avoid tutorial-style comments that explain what code does.
- Comments should explain **why**, not **what** (the code itself should be
  self-explanatory)
- Always prefer ascii characters over unicode (e.g., arrows as -> over →)

### Example main.ts

```typescript
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "@/App.vue";
import router from "@/routes";
import Toast from "vue-toastification";

import "@/assets/main.css";
import "vue-toastification/dist/index.css";

const pinia = createPinia();
const app = createApp(App);

app.use(pinia);
app.use(router);
app.use(Toast, {});

app.mount("#app");
```
