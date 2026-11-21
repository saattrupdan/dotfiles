import * as filesystem from "node:fs/promises";
import { mkdir, unlink, open, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { MODEL_ID } from "./gateway.mjs";

export const provider = {
  baseUrl: "http://127.0.0.1:8084/v1",
  api: "openai-completions",
  apiKey: "local",
  models: [{
    id: MODEL_ID,
    name: "Inkling 2 Mini",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    samplingParams: { temperature: 1, top_p: 1, top_k: 0, min_p: 0 },
    samplingParamsByThinkingLevel: { off: { reasoning_effort: "none" } },
    compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
  }],
};

/** Add one provider atomically without replacing local credentials or defaults. */
export async function registerModel(file, io = filesystem) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = `${file}.mlx-lock`;
  const lock = await acquireLock(lockPath);
  try { return await mergeModel(file, io); }
  finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function mergeModel(file, { readFile, writeFile, rename, unlink }) {
  let original;
  try { original = await readFile(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const config = original === undefined ? {} : JSON.parse(original);
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      (config.providers !== undefined && (!config.providers || typeof config.providers !== "object" || Array.isArray(config.providers)))) {
    throw new Error("Invalid Pi models configuration; file unchanged");
  }
  if (config.providers?.mlx !== undefined) {
    if (isDeepStrictEqual(config.providers.mlx, provider)) return false;
    const previousProviders = [
      { id: "inkling-2-mini-heretic", name: "Inkling 2 Mini Heretic · MLX 4-bit" },
      { id: "mlx-inkling-2-mini", name: "Inkling 2 Mini" },
      { id: MODEL_ID, name: "Inkling 2 Mini" },
    ].map((previous) => ({ ...provider, models: [{ ...provider.models[0], contextWindow: 32768, ...previous }] }));
    if (!previousProviders.some((previous) => isDeepStrictEqual(config.providers.mlx, previous))) {
      throw new Error("Pi already has a different 'mlx' provider; file unchanged");
    }
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ ...config, providers: { ...config.providers, mlx: provider } }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (original !== undefined) {
      const backup = `${file}.pre-mlx`;
      // Keep the first rollback copy; never print its contents or place it in Git.
      try { await writeFile(backup, original, { mode: 0o600, flag: "wx" }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const current = await readFile(file, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (current !== original) throw new Error("Pi models configuration changed during registration; retry setup");
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  return true;
}

async function acquireLock(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(String(process.pid)); }
      catch (error) {
        await handle.close();
        await unlink(path);
        throw error;
      }
      return handle;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A terminated setup must not leave a lock across the next reboot.
      try {
        const handle = await open(path, "r");
        try {
          const identity = await handle.stat();
          const pid = Number(await handle.readFile("utf8"));
          if (Number.isSafeInteger(pid) && pid > 1) {
            try { process.kill(pid, 0); }
            catch (error) {
              if (error.code !== "ESRCH") throw error;
              const current = await stat(path);
              if (current.ino === identity.ino && current.dev === identity.dev) await unlink(path);
            }
          }
        } finally { await handle.close(); }
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
  }
  throw new Error("Another Pi model registration is in progress; retry setup");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  registerModel(resolve(homedir(), ".pi/agent/models.json")).then((changed) => {
    if (changed) console.log(`Pi model registered: mlx/${MODEL_ID}`);
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
