import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerModel } from "./register-model.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(homedir(), "local-models/.cache");
const environment = resolve(root, "inkling-mlx-env");
const python = resolve(environment, "bin/python");
const lock = resolve(directory, "requirements.lock");
const stamp = resolve(environment, ".requirements.sha256");

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Inkling MLX requires Apple Silicon macOS");
  }
  const model = resolve(root, "inkling-mlx-heretic-4bit");
  const config = JSON.parse(await readFile(resolve(model, "config.json"), "utf8"));
  if (config.text_config?.loop_config?.num_passes !== 3) {
    throw new Error("Inkling configuration must retain all three loop passes");
  }
  const index = JSON.parse(await readFile(resolve(model, "model.safetensors.index.json"), "utf8"));
  for (const file of new Set(Object.values(index.weight_map))) await access(resolve(model, file));
  for (const file of ["chat_template.jinja", "tokenizer.json", "processor_config.json"]) await access(resolve(model, file));
  await access(resolve(root, "inkling-mlx-regular/mtp.safetensors"));
  const digest = createHash("sha256").update(await readFile(lock)).digest("hex");
  const installed = await readFile(stamp, "utf8").catch(() => "");
  let hasPython = true;
  try { await access(python); } catch { hasPython = false; }
  if (!hasPython || installed !== digest) {
    await mkdir(root, { recursive: true });
    if (!hasPython) run("uv", ["venv", "--python", "3.12", environment]);
    run("uv", ["pip", "sync", "--python", python, lock]);
    await writeFile(stamp, digest);
  }
  if (await registerModel(resolve(homedir(), ".pi/agent/models.json"))) {
    console.log("Pi: mlx/mlx-inkling-2-mini registered (text + images)");
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status ?? result.signal}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
