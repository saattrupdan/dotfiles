import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { installedModels, workerCommand, modelReady, MODEL_ID } from "./models.mjs";

async function installation(t) {
  const home = await mkdtemp(resolve(tmpdir(), "inkling-models-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = resolve(home, "local-models/.cache");
  const put = async (file, text = "fixture") => {
    const path = resolve(root, file);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, text);
    return path;
  };
  await chmod(await put("inkling-mlx-env/bin/python"), 0o700);
  const directory = "inkling-mlx-openuncensored-4bit";
  await put(`${directory}/config.json`, JSON.stringify({ text_config: { loop_config: { num_passes: 3 } }, quantization: { bits: 4 } }));
  await put(`${directory}/model.safetensors.index.json`, JSON.stringify({ weight_map: { weight: "model.safetensors" } }));
  for (const file of ["model.safetensors", "mtp.safetensors", "chat_template.jinja", "tokenizer.json", "processor_config.json"]) await put(`${directory}/${file}`);
  return { home, root, put };
}

test("only the self-contained retained model is advertised without any retired directories", async (t) => {
  const { home, root, put } = await installation(t);
  await put("inkling-atomic-gguf/Inkling-2-Mini-Uncensored-AD-Q4_K.gguf");
  const models = await installedModels({ home });
  assert.equal(models.length, 1);
  assert.equal(models[0].variant, "mlx");
  assert.equal(models[0].name, "Inkling 2 Small");
  assert.equal(MODEL_ID, "inkling-2-small");
  assert.equal(models[0].modelPath, resolve(root, "inkling-mlx-openuncensored-4bit"));
  assert.equal(models[0].draftPath, models[0].modelPath);
  const command = workerCommand(models[0], 18084);
  assert.deepEqual(command.slice(0, 5), ["/usr/bin/env", "APC_ENABLED=1", "APC_DISK_ENABLED=0", "APC_MEMORY_MAX_GB=4", models[0].python]);
  assert.equal(command[command.indexOf("--draft-model") + 1], models[0].modelPath);
  assert.equal(command[command.indexOf("--draft-block-size") + 1], "4");
  assert.equal(modelReady(models[0], { model_ready: true, loaded_model: models[0].modelPath }), true);
  assert.equal(modelReady(models[0], { model_ready: true, loaded_model: "/retired" }), false);
});

test("missing local draft weights fail even when a retired source draft still exists", async (t) => {
  const { home, root, put } = await installation(t);
  await rm(resolve(root, "inkling-mlx-openuncensored-4bit/mtp.safetensors"));
  await put("inkling-openuncensored-native/mtp.safetensors");
  await assert.rejects(installedModels({ home }), /installation is incomplete/);
  assert.equal((await installedModels({ home, strict: false }))[0].variant, "mlx");
});

test("incomplete, reduced-pass or wrong-quantization targets are rejected", async (t) => {
  const { home, root, put } = await installation(t);
  for (const [passes, bits] of [[2, 4], [3, 3]]) {
    await put("inkling-mlx-openuncensored-4bit/config.json", JSON.stringify({ text_config: { loop_config: { num_passes: passes } }, quantization: { bits } }));
    await assert.rejects(installedModels({ home }), /three-pass MLX 4-bit/);
  }
  await rm(resolve(root, "inkling-mlx-openuncensored-4bit/config.json"));
  await assert.rejects(installedModels({ home }), /installation is incomplete/);
});
