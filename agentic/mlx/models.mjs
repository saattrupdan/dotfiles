import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const MODEL_ID = "inkling-2-small";
export const DEFAULT_VARIANT = "mlx";

/** Describe installed backends without importing MLX or loading any weights. */
export async function installedModels({ home = homedir(), python, strict = true } = {}) {
  const root = resolve(home, "local-models/.cache");
  python ??= resolve(root, "inkling-mlx-env/bin/python");
  const modelPath = resolve(root, "inkling-mlx-openuncensored-4bit");
  const specs = [{ variant: "mlx", name: "Inkling 2 Small", kind: "mlx", modelPath, draftPath: modelPath }];
  const available = [];
  for (const spec of specs) {
    try {
      if (spec.kind === "mlx") {
        const config = JSON.parse(await readFile(resolve(spec.modelPath, "config.json"), "utf8"));
        if (config.text_config?.loop_config?.num_passes !== 3 || config.quantization?.bits !== 4) throw new Error("Expected three-pass MLX 4-bit configuration");
        const index = JSON.parse(await readFile(resolve(spec.modelPath, "model.safetensors.index.json"), "utf8"));
        const shards = Object.values(index.weight_map ?? {});
        if (!shards.length) throw new Error("No model shards indexed");
        for (const file of new Set([...shards, "chat_template.jinja", "tokenizer.json", "processor_config.json"])) await access(resolve(spec.modelPath, file));
        await access(resolve(spec.draftPath, "mtp.safetensors"));
        await access(python, constants.X_OK);
      } else {
        await access(spec.modelPath);
        await access(spec.projectorPath);
        await access(spec.binary, constants.X_OK);
      }
      available.push({ ...spec, python, upstreamModel: spec.kind === "mlx" ? spec.modelPath : MODEL_ID });
    } catch (error) {
      if (spec.variant === DEFAULT_VARIANT) {
        if (strict) throw new Error(`Current Inkling installation is incomplete: ${error.message}`);
        available.push({ ...spec, python, upstreamModel: spec.modelPath });
      }
      // Optional variants are advertised only when their entire installation exists.
    }
  }
  return available;
}

export function workerCommand(model, port) {
  if (model.kind === "llamacpp") return [model.binary,
    "--host", "127.0.0.1", "--port", String(port), "--model", model.modelPath,
    "--mmproj", model.projectorPath, "--alias", MODEL_ID, "--jinja",
    "--ctx-size", "262144", "--parallel", "1", "--gpu-layers", "99", "--ubatch-size", "128",
    "--flash-attn", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"];
  return ["/usr/bin/env", "APC_ENABLED=1", "APC_DISK_ENABLED=0", "APC_MEMORY_MAX_GB=4",
    model.python, "-m", "mlx_vlm.server",
    "--host", "127.0.0.1", "--port", String(port), "--model", model.modelPath,
    "--draft-model", model.draftPath, "--draft-kind", "dflash", "--draft-block-size", "4",
    "--prefill-step-size", "256", "--max-num-seqs", "1"];
}

export function modelReady(model, health) {
  return model.kind === "llamacpp" ? health.status === "ok" :
    health.model_ready === true && health.loaded_model === model.modelPath;
}
