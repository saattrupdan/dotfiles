import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(root, "_outliner", "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });

await jiti.import(path.join(root, "_outliner", "outliner.test.ts"), { default: false });
await jiti.import(path.join(root, "_voice-input", "syv.test.ts"), { default: false });
await jiti.import(path.join(root, "search", "index-store.test.ts"), { default: false });
await jiti.import(path.join(root, "mcp-collapse", "index.test.ts"), { default: false });
await jiti.import(path.join(root, "read", "heic.test.ts"), { default: false });
await jiti.import(path.join(root, "subagent", "session-label.test.ts"), { default: false });
await jiti.import(path.join(root, "web-search", "index.test.ts"), { default: false });
