import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAgentProfile } from "./definition.mjs";
import { buildProfileArgs, loadProfile, resolvePiPackage, selectProfile } from "./launcher.mjs";

const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });

function root() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-profile-test-"));
	roots.push(dir);
	fs.mkdirSync(path.join(dir, "agents"));
	fs.mkdirSync(path.join(dir, "extensions", "private"), { recursive: true });
	fs.writeFileSync(path.join(dir, "extensions", "private", "index.ts"), "export default () => {};\n");
	fs.mkdirSync(path.join(dir, "skills", "memory"), { recursive: true });
	fs.writeFileSync(path.join(dir, "skills", "memory", "SKILL.md"), "---\nname: memory\n---\n");
	return dir;
}

const profile = (name, data = {}) => parseAgentProfile({
	name, description: "A test profile", subagent: false, tools: ["recall_memory"],
	skills: ["memory"], extensions: ["private"], ...data,
}, "Only use memory.\n", `${name}.md`);

test("validates role, resource lists, and empty allow-lists", () => {
	assert.equal(profile("librarian").subagent, false);
	assert.deepEqual(profile("librarian", { tools: [], skills: [], extensions: [] }).tools, []);
	assert.equal(parseAgentProfile({ name: "old-agent", description: "old" }, "Prompt", "old.md").subagent, true);
	assert.throws(() => profile("librarian", { subagent: "false" }), /subagent must be true or false/);
	assert.throws(() => profile("librarian", { extensions: ["../private"] }), /simple names/);
	assert.throws(() => profile("librarian", { tools: [5] }), /tools must be/);
	for (const tools of [["+read"], ["-bash"], ["mcp__*"], ["*"]]) {
		assert.throws(() => profile("librarian", { tools }), /literal tool names/);
	}
	assert.deepEqual(profile("main", { tools: ["clean-up-isolated-branch", "mcp__zoho_email__ZohoMail_listEmails"] }).tools,
		["clean-up-isolated-branch", "mcp__zoho_email__ZohoMail_listEmails"]);
	assert.throws(() => profile("librarian", { refuse: [{ pattern: "[", message: "bad" }] }), SyntaxError);
});

test("selects the requested profile without consuming prompts after --", () => {
	assert.deepEqual(selectProfile(["--agent", "librarian", "--continue"]), { agent: "librarian", args: ["--continue"] });
	assert.deepEqual(selectProfile(["--", "--agent", "librarian"]), { agent: "main", args: ["--", "--agent", "librarian"] });
	assert.throws(() => selectProfile(["--agent", "a", "--agent", "b"]), /once/);
});

test("loads prompt body rather than YAML and refuses delegatable top-level agents", async () => {
	const dir = root();
	fs.writeFileSync(path.join(dir, "agents", "main.md"), "---\nname: main\ndescription: Main\nsubagent: false\ntools: []\nskills: []\nextensions: [private]\n---\n\nMain instructions.\n");
	const main = await loadProfile("main", dir, resolvePiPackage());
	assert.equal(main.systemPrompt.trim(), "Main instructions.");
	assert.deepEqual(main.extensions, ["private"]);
	fs.writeFileSync(path.join(dir, "agents", "builder.md"), "---\nname: builder\ndescription: Builder\nsubagent: true\ntools: []\nskills: []\nextensions: [private]\n---\nBuild.\n");
	await assert.rejects(loadProfile("builder", dir, resolvePiPackage()), /subagent: false/);
	fs.writeFileSync(path.join(dir, "agents", "main.md"), "---\nname: main\ndescription: Main\nsubagent: true\ntools: []\nskills: []\nextensions: [private]\n---\nMain.\n");
	await assert.rejects(loadProfile("main", dir, resolvePiPackage()), /subagent: false/);
	assert.throws(() => buildProfileArgs(profile("main", { skills: undefined }), dir, []), /explicit resource allow-lists/);
});

test("actual librarian profile exposes exactly six private memory tools", async () => {
	const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const librarian = await loadProfile("librarian", dir, resolvePiPackage());
	assert.deepEqual(librarian.tools, ["search_concepts", "read_concept", "create_concept", "update_concept", "remove_concept", "lint_concepts"]);
	assert.deepEqual(librarian.extensions, ["memory", "rate-limit-retry"]);
	assert.deepEqual(librarian.skills, []);
	assert.deepEqual(librarian.model, ["openai-codex/gpt-6-luna"]);
	const sandbox = root();
	for (const extension of librarian.extensions) {
		fs.mkdirSync(path.join(sandbox, "extensions", extension), { recursive: true });
		fs.writeFileSync(path.join(sandbox, "extensions", extension, "index.ts"), "export default () => {};\n");
	}
	const args = buildProfileArgs(librarian, sandbox, ["--no-session"]);
	assert.ok(args.includes("--no-mcp"));
	assert.ok(args.includes("--no-skills"));
	assert.equal(args.filter((arg) => arg === "--extension").length, 2);
	assert.equal(args[args.indexOf("--tools") + 1], librarian.tools.join(","));
	assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-6-luna");
});

test("main exposes only the two handoff tools, not the librarian's concept tools", async () => {
	const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const main = await loadProfile("main", dir, resolvePiPackage());
	assert.ok(main.extensions.includes("memory-handoff"));
	assert.ok(main.extensions.includes("mcp"));
	assert.equal(main.tools.filter((tool) => tool.startsWith("mcp__zoho_email__")).length, 10);
	const args = buildProfileArgs(main, dir, ["--no-session"]);
	assert.ok(args.some((arg, index) => arg === "--extension" && args[index + 1] === "builtin:mcp"));
	assert.ok(main.extensions.includes("memory-snapshot"));
	assert.ok(!main.extensions.includes("memory"));
	assert.ok(!main.extensions.includes("memory-async"));
	assert.ok(!main.extensions.includes("mcp-collapse"));
	for (const tool of ["mcp", "memory_query", "memory_add", "memory_update"]) {
		assert.ok(!main.tools.includes(tool), tool);
	}
	assert.ok(main.tools.includes("store_memory") && main.tools.includes("recall_memory"));
	for (const tool of ["search_concepts", "read_concept", "create_concept", "update_concept", "remove_concept", "lint_concepts"]) {
		assert.ok(!main.tools.includes(tool), tool);
	}
});

test("scopes private tools, skills, extensions and sessions before startup", () => {
	const dir = root();
	const args = buildProfileArgs(profile("librarian"), dir, ["--continue"]);
	assert.deepEqual(args.slice(0, 2), ["--system-prompt", args[1]]);
	assert.equal(fs.readFileSync(args[1], "utf8"), "Only use memory.\n");
	for (const flag of ["--no-extensions", "--extension", "--no-mcp", "--session-dir", "--no-skills", "--skill", "--tools"]) {
		assert.ok(args.includes(flag), `missing ${flag}`);
	}
	assert.equal(args.at(-1), "--continue");
	assert.equal(args[args.indexOf("--tools") + 1], "recall_memory");
	assert.equal(args[args.indexOf("--session-dir") + 1], path.join(dir, "profile-sessions", "librarian"));
	const none = buildProfileArgs(profile("librarian", { tools: [], skills: [], extensions: [] }), dir, []);
	assert.ok(none.includes("--no-tools"));
	assert.ok(none.includes("--no-skills"));
	assert.ok(none.includes("--no-extensions"));
	assert.ok(!none.includes("--extension"));
	const optOut = buildProfileArgs(profile("main"), dir, ["--no-extensions", "--no-session"]);
	assert.ok(!optOut.includes("--extension"));
	assert.throws(() => buildProfileArgs(profile("librarian"), dir, ["--extension", "somewhere"]), /cannot override/);
	assert.throws(() => buildProfileArgs(profile("librarian"), dir, ["--tools=write"]), /cannot override/);
});

test("keeps main session storage separate and rejects cross-profile paths", () => {
	const dir = root();
	const main = buildProfileArgs(profile("main"), dir, ["--continue"]);
	assert.ok(!main.includes("--session-dir"));
	const privateFile = path.join(dir, "profile-sessions", "librarian", "session.jsonl");
	assert.throws(() => buildProfileArgs(profile("main"), dir, ["--session", privateFile]), /another agent profile/);
	assert.throws(() => buildProfileArgs(profile("main"), dir, [], dir, path.join(dir, "profile-sessions", "librarian")), /cannot resume a private profile/);
	assert.throws(() => buildProfileArgs(profile("librarian"), dir, ["--fork", path.join(dir, "sessions", "main.jsonl")]), /another agent profile/);
	assert.throws(() => buildProfileArgs(profile("librarian"), dir, ["--session-dir", "/tmp/other"]), /cannot be overridden/);
	assert.doesNotThrow(() => buildProfileArgs(profile("librarian"), dir, ["--session-id", "123"]));
});
