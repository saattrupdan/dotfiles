import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { delegatableAgents, discoverAgents } from "./agents.ts";

function withAgents(run: (root: string, project: string) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-discovery-"));
	const project = path.join(root, "project");
	fs.mkdirSync(path.join(root, "agents"));
	fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try { run(root, project); }
	finally {
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prior;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function agent(dir: string, name: string, subagent: boolean, extra = "") {
	fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: Agent ${name}\nsubagent: ${subagent}\n${extra}---\n\nPrompt for ${name}.\n`);
}

test("only subagent profiles are offered for delegation", () => withAgents((root, project) => {
	agent(path.join(root, "agents"), "main", false);
	agent(path.join(root, "agents"), "builder", true, "tools: []\nextensions: [read]\n");
	const all = discoverAgents(project, "user").agents;
	expect(all.map((a) => a.name).sort()).toEqual(["builder", "main"]);
	expect(delegatableAgents(all).map((a) => a.name)).toEqual(["builder"]);
	expect(all.find((a) => a.name === "builder")?.tools).toEqual([]);
	expect(all.find((a) => a.name === "builder")?.extensions).toEqual(["read"]);
}));

test("a project cannot override or delegate a private user profile", () => withAgents((root, project) => {
	agent(path.join(root, "agents"), "main", false);
	agent(path.join(project, ".pi", "agents"), "main", true);
	agent(path.join(project, ".pi", "agents"), "helper", true);
	expect(delegatableAgents(discoverAgents(project, "both").agents).map((a) => a.name)).toEqual(["helper"]);
	expect(delegatableAgents(discoverAgents(project, "project").agents).map((a) => a.name)).toEqual(["helper"]);
}));

test("invalid frontmatter fails rather than widening access", () => withAgents((root, project) => {
	fs.writeFileSync(path.join(root, "agents", "main.md"), "---\nname: main\ndescription: Main\nsubagent: nope\n---\nPrompt\n");
	expect(() => discoverAgents(project, "user")).toThrow(/subagent must be true or false/);
}));
