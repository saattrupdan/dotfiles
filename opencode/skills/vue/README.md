# vue

Reference for Vue.js frontend conventions.

## Requirements

- Node.js and npm
- Vue 3 with Composition API
- Related skills: `full-stack` (full-stack project structure)

## Quick Start

```bash
# Create a new Vue project
npm create vue@latest my-project

# Install dependencies
cd my-project
npm install

# Run the development server
npm run dev

# Run quality checks (type checking + linting)
npm run check
```

## Project Structure

```
my-project/
├── package.json
├── Makefile
├── src/
│   ├── frontend/             # All Vue frontend code lives here
│   │   ├── assets/
│   │   ├── components/
│   │   ├── App.vue
│   │   └── main.ts
│   └── routes.ts             # vue-router configuration
└── tests/
```

## Conventions

### File Structure

- All `vue` files must contain `<script>`, `<template>`, and `<style>` tags, **in that order**
- Script tags must be TypeScript: `<script setup lang="ts">`
- Style tags must be scoped: `<style scoped>`
- Use regular CSS — no UI frameworks such as Tailwind

### Code Quality

| Tool | Purpose |
|---|---|
| Prettier | Formatting |
| ESLint | Linting |
| vue-tsc | Type checking |

The `check` script in `package.json` should be defined as:

```json
{
  "scripts": {
    "check": "vue-tsc --noEmit && eslint src/frontend --ext .vue,.js,.jsx,.cjs,.mjs,.ts,.tsx,.cts,.mts --fix"
  }
}
```

The `Makefile` should have a `check` recipe that includes `npm run check`.

### Standard Packages

| Package | Purpose |
|---|---|
| `vue-router` | Routing |
| `pinia` | State management |
| `vue-toastification` | Toast notifications |
| `vue3-spinners` | Loading spinners |

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

### Documentation

- Avoid tutorial-style comments that explain what code does
- Comments should explain **why**, not **what**
- Always prefer ASCII characters over Unicode (e.g., `->` over `→`)

### Code Width

All code should fit within **88 characters**.
