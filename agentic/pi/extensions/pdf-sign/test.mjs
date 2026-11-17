import { createRequire } from "node:module";
import { URL, fileURLToPath } from "node:url";
const require = createRequire(new URL("../_outliner/package.json", import.meta.url));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });
await jiti.import(fileURLToPath(new URL("./index.test.ts", import.meta.url)), { default: false });
await jiti.import(fileURLToPath(new URL("./launcher.test.ts", import.meta.url)), { default: false });
await jiti.import(fileURLToPath(new URL("./focus.test.ts", import.meta.url)), { default: false });
