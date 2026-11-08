import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";

import registerCodeTree from "../code-tree/index.ts";
import registerGenerateImage from "../generate-image/index.ts";
import registerGenerateVideo from "../generate-video/index.ts";
import registerMemory from "../memory-handoff/index.ts";
import registerQuestion from "../question/index.ts";
import registerRead from "../read/index.ts";
import registerSearch from "../search/index.ts";
import registerSkill from "../skill/index.ts";
import registerSubagent from "../subagent/index.ts";
import registerWebBrowse from "../web-browse/index.ts";
import registerWebSearch from "../web-search/index.ts";
import { renderExpandedCall } from "./expanded-call.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const longText = "Full submitted text: " + "long argument ".repeat(12).trimEnd() + "\nsecond line with 'quotes'.";

function rendered(display: { render(width: number): string[] }): string {
	return display.render(10_000).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
}

test("expanded argument formatting preserves multiline text, false, zero and arrays", () => {
	assert.equal(rendered(renderExpandedCall("tool", {
		prompt: "first\nsecond", enabled: false, offset: 0, skills: ["python"], omitted: undefined,
	}, theme as never)), 'tool\nprompt: first\nsecond\nenabled: false\noffset: 0\nskills: [\n  "python"\n]');
	assert.equal(rendered(renderExpandedCall("tool", undefined, theme as never)), "tool");
});

test("registered custom tools expose submitted arguments and full results when expanded", async () => {
	initTheme("dark");
	const tools = new Map<string, Tool>();
	const shutdown: Array<() => Promise<void>> = [];
	const pi = {
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (event: string, handler: () => Promise<void>) => {
			if (event === "session_shutdown") shutdown.push(handler);
		},
	};
	const previous = process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_CHILD;
	try {
		for (const register of [registerCodeTree, registerGenerateImage, registerGenerateVideo, registerMemory, registerQuestion,
			registerRead, registerSearch, registerSkill, registerSubagent, registerWebBrowse, registerWebSearch]) {
			await register(pi as never);
		}
		const fixtures: Record<string, Record<string, unknown>> = {
			code_tree: { path: "src", depth: 3, include_files: false },
			generate_image: { prompt: longText, size: "1024x768", num: 2 },
			generate_video: { prompt: longText, seconds: 5, aspect_ratio: "16:9", steps: 2, seed: 0 },
			store_memory: { text: longText },
			recall_memory: { text: longText },
			question: { question: longText, options: ["Keep", "Replace"], multiSelect: true },
			read: { path: "src/main.ts", offset: 0, limit: 8192 },
			search: { query: longText, kind: "ref", regex: false, maxResults: 42 },
			skill: { name: "codebase-design" },
			subagent: { agent: "explorer", taskName: "Audit display", task: longText, cwd: "/tmp/work",
				model: "test-model", skills: ["python"], agentScope: "both", confirmProjectAgents: false },
			web_browse: { command: "open https://example.test/" + "path/".repeat(30), timeout_ms: 5000 },
			web_search: { query: longText, max_results: 7, language: "da", categories: "news",
				time_range: "week", safe_search: 0, page: 2 },
		};
		for (const [name, args] of Object.entries(fixtures)) {
			const tool = tools.get(name)!;
			assert.ok(tool?.renderCall, name);
			const context = { expanded: true, isPartial: false, isError: false, args, toolCallId: "render-test" };
			const call = rendered(tool.renderCall(args, theme as never, context as never));
			for (const value of Object.values(args)) {
				for (const item of Array.isArray(value) ? value : [value]) {
					assert.ok(call.includes(String(item)), `${name} hides ${String(item)}`);
				}
			}
			if (!tool.renderResult) continue; // Pi's default result renderer handles question.
			for (const isError of [false, true]) {
				const text = `${isError ? "Error details" : "Full result"}\n${longText}`;
				const result = tool.renderResult({ content: [{ type: "text", text }], details: undefined },
					{ expanded: true, isPartial: false }, theme as never, { ...context, isError } as never);
				assert.ok(rendered(result).includes(text), `${name} hides expanded ${isError ? "error" : "result"}`);
			}
		}
		const browser = tools.get("web_browse")!;
		for (const verb of ["fill", "type", "select"]) {
			const call = rendered(browser.renderCall!({ command: `${verb} @e2 private-form-value`, timeout_ms: 5000 },
				theme as never, { expanded: true } as never));
			assert.ok(call.includes(`${verb} @e2 [text redacted]`));
			assert.ok(call.includes("5000"));
			assert.ok(!call.includes("private-form-value"));
		}
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
		for (const handler of shutdown) await handler();
	}
});
