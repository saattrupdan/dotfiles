import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createContext, runInContext } from "node:vm";
import { parse, compileScript } from "vue/compiler-sfc";
import { transformSync } from "esbuild";
import type { Message } from "../src/frontend/stores/sessions.ts";

const source = fs.readFileSync(
  new URL("../src/frontend/components/Transcript.vue", import.meta.url),
  "utf8",
);
const { descriptor } = parse(source);
const ast = compileScript(descriptor, { id: "transcript-test" }).scriptSetupAst!;
const declaration = ast.find(
  (node) =>
    node.type === "VariableDeclaration" &&
    node.declarations.some(
      (item) => item.id.type === "Identifier" && item.id.name === "parts",
    ),
)!;
const context = createContext({});
runInContext(
  transformSync(
    descriptor.scriptSetup!.content.slice(declaration.start!, declaration.end!) +
      "\nglobalThis.fixtureParts = parts;",
    { loader: "ts" },
  ).code,
  context,
);
const parts = context.fixtureParts as (message: Message) => Array<{
  type: string;
  text?: string;
}>;
const annotation =
  "[Image: original 3024x4032, displayed at 1500x2000. Multiply coordinates by 2.02 to map to original image.]";
const image = { type: "image", mimeType: "image/png", data: "fixture" };

test("transcript hides internal sizing annotations next to images, not the image or prompt", () => {
  const prompt = { type: "text", text: "Describe this image." };
  for (const content of [
    [prompt, image, { type: "text", text: annotation }],
    [prompt, { type: "text", text: annotation }, image],
  ]) {
    const result = parts({ role: "user", content });
    assert.equal(result.length, 2);
    assert.equal(result[0], prompt);
    assert.equal(result[1], image);
    assert.equal(content.length, 3, "native message content is not mutated");
  }
});

test("transcript removes an SDK note appended to the prompt text", () => {
  const text =
    "Describe the attached image.\n<!-- pi-remote-command:c2d90aba-4820-494b-978d-1991e3e820cf -->";
  const original = { type: "text", text: `${text}\n${annotation}` };
  const result = parts({ role: "user", content: [original, image] });
  assert.equal(result[0]?.text, text);
  assert.equal(result[1], image);
  assert.equal(original.text, `${text}\n${annotation}`);
});

test("transcript preserves ordinary text, even when it discusses image annotations", () => {
  for (const text of [
    annotation,
    `What does ${annotation} mean?`,
    "[Image: original painting by the artist]",
  ]) {
    assert.equal(parts({ role: "user", content: text })[0]?.text, text);
    const content = [{ type: "text", text }, image];
    if (text !== annotation)
      assert.equal(parts({ role: "user", content })[0]?.text, text);
  }
});

test("transcript preserves sizing text that is not an adjacent generated image block", () => {
  const caption = { type: "text", text: annotation };
  const content = [caption, { type: "text", text: "Quoted metadata." }, image];
  assert.equal(parts({ role: "user", content })[0], caption);
});
