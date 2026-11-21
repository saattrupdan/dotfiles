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
  const mlx = async (directory, draft, passes = 3) => {
    await put(`${directory}/config.json`, JSON.stringify({ text_config: { loop_config: { num_passes: passes } }, quantization: { bits: 4 } }));
    await put(`${directory}/model.safetensors.index.json`, JSON.stringify({ weight_map: { weight: "model.safetensors" } }));
    for (const file of ["model.safetensors", "chat_template.jinja", "tokenizer.json", "processor_config.json"]) await put(`${directory}/${file}`);
    await put(`${draft}/mtp.safetensors`);
  };
  await mlx("inkling-mlx-heretic-4bit", "inkling-mlx-regular");
  return { home, root, put, mlx };
}

test("optional absent, partial and invalid installations are not advertised", async (t) => {
  const { home, put, mlx } = await installation(t);
  assert.deepEqual((await installedModels({ home })).map((model) => model.variant), ["mlx"]);
  await put("inkling-atomic-gguf/Inkling-2-Mini-Uncensored-AD-Q4_K.gguf");
  await mlx("inkling-mlx-openuncensored-4bit", "inkling-openuncensored-native", 2);
  assert.deepEqual((await installedModels({ home })).map((model) => model.variant), ["mlx"]);
});

test("complete alternatives preserve three passes and build independent backend commands", async (t) => {
  const { home, put, mlx } = await installation(t);
  await mlx("inkling-mlx-openuncensored-4bit", "inkling-openuncensored-native");
  for (const name of ["AD-Q4_K", "F16"]) await put(`inkling-atomic-gguf/${name === "F16" ? "mmproj-" : ""}Inkling-2-Mini-Uncensored-${name}.gguf`);
  await chmod(await put("inkling-llama-b12608/llama-b12608/llama-server"), 0o700);
  const models = await installedModels({ home });
  assert.deepEqual(models.map((model) => model.variant), ["mlx", "openuncensored", "atomicchat"]);
  const native = workerCommand(models[1], 18084);
  assert.equal(native[native.indexOf("--model") + 1], models[1].modelPath);
  assert.equal(native[native.indexOf("--draft-model") + 1], models[1].draftPath);
  const gguf = workerCommand(models[2], 18084);
  assert.equal(gguf[gguf.indexOf("--ctx-size") + 1], "262144");
  assert.equal(gguf[gguf.indexOf("--parallel") + 1], "1");
  assert.equal(models[2].upstreamModel, MODEL_ID);
  assert.equal(modelReady(models[1], { model_ready: true, loaded_model: models[0].modelPath }), false);
  assert.equal(modelReady(models[1], { model_ready: true, loaded_model: models[1].modelPath }), true);
  assert.equal(modelReady(models[2], { status: "loading" }), false);
  assert.equal(modelReady(models[2], { status: "ok" }), true);
});

test("setup rejects an incomplete current installation while standalone discovery remains lazy", async (t) => {
  const { home, root } = await installation(t);
  await rm(resolve(root, "inkling-mlx-heretic-4bit/config.json"));
  await assert.rejects(installedModels({ home }), /Current Inkling installation is incomplete/);
  assert.equal((await installedModels({ home, strict: false }))[0].variant, "mlx");
});
