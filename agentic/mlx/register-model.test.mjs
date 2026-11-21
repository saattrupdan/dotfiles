import test from "node:test";
import * as filesystem from "node:fs/promises";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerModel, provider } from "./register-model.mjs";

async function fixture(t, content) {
  const directory = await mkdtemp(join(tmpdir(), "pi-mlx-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "models.json");
  if (content !== undefined) await writeFile(file, content);
  return { directory, file };
}

test("adds image-capable model without changing unrelated credentials and settings", async (t) => {
  const original = { unknown: { keep: true }, providers: { other: { apiKey: "fixture-secret", models: [{ id: "existing" }] } } };
  const { file } = await fixture(t, JSON.stringify(original));
  assert.equal(await registerModel(file), true);
  const config = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(config, { ...original, providers: { ...original.providers, mlx: provider } });
  assert.deepEqual(provider.models[0].input, ["text", "image"]);
  assert.equal(provider.models[0].contextWindow, 32768);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(`${file}.pre-mlx`)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(`${file}.pre-mlx`, "utf8")), original);
});

test("registration is idempotent and keeps the first rollback copy", async (t) => {
  const { file, directory } = await fixture(t, '{"providers":{}}');
  await registerModel(file);
  const initial = await readFile(file, "utf8");
  assert.equal(await registerModel(file), false);
  assert.equal(await readFile(file, "utf8"), initial);
  assert.equal(await readFile(`${file}.pre-mlx`, "utf8"), '{"providers":{}}');
  assert.deepEqual((await readdir(directory)).sort(), ["models.json", "models.json.pre-mlx"]);
});

test("malformed or conflicting configuration remains byte-for-byte unchanged", async (t) => {
  for (const content of ['{broken', '[]', '{"providers":[]}', '{"providers":{"mlx":{"apiKey":"keep"}}}']) {
    const { file, directory } = await fixture(t, content);
    await assert.rejects(registerModel(file));
    assert.equal(await readFile(file, "utf8"), content);
    assert.deepEqual(await readdir(directory), ["models.json"]);
  }
});

test("a new installation creates a private model registry", async (t) => {
  const { file } = await fixture(t);
  assert.equal(await registerModel(file), true);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { providers: { mlx: provider } });
});

test("concurrent registrations serialize and preserve the registry", async (t) => {
  const { file } = await fixture(t, '{"providers":{"other":{"apiKey":"keep"}}}');
  const results = await Promise.all([registerModel(file), registerModel(file)]);
  assert.deepEqual(results.sort(), [false, true]);
  const config = JSON.parse(await readFile(file, "utf8"));
  assert.equal(config.providers.other.apiKey, "keep");
  assert.deepEqual(config.providers.mlx, provider);
});

test("external credentials changed during registration are not overwritten", async (t) => {
  const { file } = await fixture(t, '{"providers":{"other":{"apiKey":"before"}}}');
  const changed = '{"providers":{"other":{"apiKey":"after"}}}';
  const concurrentWriter = {
    ...filesystem,
    async writeFile(path, ...args) {
      await filesystem.writeFile(path, ...args);
      if (path.endsWith(".tmp")) await filesystem.writeFile(file, changed);
    },
  };
  await assert.rejects(registerModel(file, concurrentWriter), /changed during registration/);
  assert.equal(await readFile(file, "utf8"), changed);
});
