import test from "node:test";
import * as filesystem from "node:fs/promises";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerModel, provider, providersFor } from "./register-model.mjs";
import { MODEL_ID } from "./models.mjs";

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
  assert.equal(provider.models[0].id, "inkling-2-mini");
  assert.equal(provider.models[0].name, "Inkling 2 Mini");
  assert.deepEqual(provider.models[0].input, ["text", "image"]);
  assert.equal(provider.models[0].contextWindow, 262144);
  assert.equal(provider.models[0].maxTokens, 8192);
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
  await assert.rejects(registerModel(file, { io: concurrentWriter }), /changed during registration/);
  assert.equal(await readFile(file, "utf8"), changed);
});

test("upgrades previous managed models without changing other providers", async (t) => {
  for (const previousName of [
    { id: "inkling-2-mini-heretic", name: "Inkling 2 Mini Heretic · MLX 4-bit" },
    { id: "mlx-inkling-2-mini", name: "Inkling 2 Mini" },
    { id: "inkling-2-mini", name: "Inkling 2 Mini" },
  ]) {
    const previous = { ...provider, models: [{ ...provider.models[0], contextWindow: 32768, ...previousName }] };
    const original = { providers: { mlx: previous, other: { apiKey: "keep" } } };
    const { file } = await fixture(t, JSON.stringify(original));
    assert.equal(await registerModel(file), true);
    const config = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(config.providers.mlx, provider);
    assert.deepEqual(config.providers.other, original.providers.other);
    assert.deepEqual(JSON.parse(await readFile(`${file}.pre-mlx`, "utf8")), original);
    assert.equal(await registerModel(file), false);
  }
});


test("all installed providers register atomically with private headers and preserve defaults", async (t) => {
  const { file } = await fixture(t);
  const original = { defaultProvider: "unchanged", providers: { private: { apiKey: "do-not-replace" }, mlx: provider } };
  await writeFile(file, JSON.stringify(original));
  const providers = providersFor([{ variant: "mlx" }, { variant: "openuncensored", name: "OpenUncensored" }, { variant: "atomicchat", name: "AtomicChat" }]);
  assert.equal(await registerModel(file, { providers }), true);
  const actual = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(actual.providers.mlx, provider);
  assert.deepEqual(actual.providers.private, original.providers.private);
  assert.equal(actual.defaultProvider, original.defaultProvider);
  assert.equal(actual.providers.openuncensored.headers["X-Inkling-Variant"], "openuncensored");
  assert.equal(actual.providers.atomicchat.models[0].id, MODEL_ID);
  assert.equal(actual.providers.atomicchat.models[0].contextWindow, 262144);
  assert.equal(await registerModel(file, { providers }), false);
});

test("an alternative-provider conflict leaves every proposed addition unapplied", async (t) => {
  const { file } = await fixture(t);
  const original = JSON.stringify({ providers: { atomicchat: { apiKey: "private" } } });
  await writeFile(file, original);
  const providers = providersFor([{ variant: "mlx" }, { variant: "openuncensored", name: "OpenUncensored" }, { variant: "atomicchat", name: "AtomicChat" }]);
  await assert.rejects(registerModel(file, { providers }), /different 'atomicchat' provider/);
  assert.equal(await readFile(file, "utf8"), original);
});
