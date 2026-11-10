import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resolvePiPackage } from "./pi-runtime.mjs";

const launcher = fileURLToPath(new URL("./launcher.mjs", import.meta.url));
const bridge = `import os,pty,select,signal,sys,fcntl,termios,struct,time
pid,fd=pty.fork()
if pid==0: os.execvpe(sys.argv[1],sys.argv[1:],os.environ)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
def stop(*_):
 try: os.killpg(pid,signal.SIGTERM)
 except ProcessLookupError: pass
signal.signal(signal.SIGTERM,stop)
while True:
 try:
  readable,_,_=select.select([fd,sys.stdin.buffer],[],[],0.1)
  for source in readable:
   if source==fd:
    data=os.read(fd,65536)
    if not data: sys.exit(0)
    os.write(1,data)
   else:
    data=os.read(0,65536)
    if data: os.write(fd,data)
  done,status=os.waitpid(pid,os.WNOHANG)
  if done: sys.exit(os.waitstatus_to_exitcode(status))
 except OSError: sys.exit(0)
`;

function fixture(options = {}) {
	options = { ...options, worktree: options.worktree || options.legacy };
	const role = options.role || "main";
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-profile-reload-"));
	const agentDir = path.join(root, "agent");
	for (const dir of ["agents", "extensions/old", "extensions/new", "skills/fixture"])
		fs.mkdirSync(path.join(agentDir, dir), { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "reload-test",
			defaultModel: "fixture",
			defaultThinkingLevel: "off",
		}),
	);
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"reload-test": {
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: "fixture",
					api: "openai-completions",
					models: [
						{
							id: "fixture",
							name: "Reload fixture",
							reasoning: false,
							input: ["text"],
							contextWindow: 4096,
							maxTokens: 128,
						},
					],
				},
			},
		}),
	);
	const state = path.join(root, "states.jsonl");
	for (const name of ["old", "new"])
		fs.writeFileSync(
			path.join(agentDir, "extensions", name, "index.ts"),
			`import fs from 'node:fs'; export default function(pi) {
 pi.registerTool({name:'${name}_tool',label:'fixture',description:'fixture',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'fixture'}]}}});
 pi.registerCommand('fixture-hop',{description:'Fixture continuation',handler:async(_,ctx)=>{process.send({type:'pi-profile-continuation',cwd:ctx.cwd,args:process.argv.slice(2),changes:{}});ctx.shutdown();}});
 pi.on('session_start',(_,ctx)=>fs.appendFileSync(${JSON.stringify(state)},JSON.stringify({pid:process.pid,active:pi.getActiveTools(),all:pi.getAllTools().map(t=>t.name),prompt:ctx.getSystemPrompt(),commands:pi.getCommands(),session:ctx.sessionManager.getSessionFile(),id:ctx.sessionManager.getSessionId(),model:ctx.model?.id,thinking:ctx.thinkingLevel,name:ctx.sessionManager.getSessionName()})+'\\n'));
}`,
		);
	fs.writeFileSync(
		path.join(agentDir, "skills/fixture/SKILL.md"),
		"---\nname: fixture\ndescription: Unique reloaded skill description.\n---\nFixture skill.\n",
	);
	if (options.worktree)
		fs.symlinkSync(
			fileURLToPath(new URL("../extensions/git-worktree-isolation", import.meta.url)),
			path.join(agentDir, "extensions/git-worktree-isolation"),
			"dir",
		);
	if (options.consume) {
		fs.mkdirSync(path.join(agentDir, "extensions/consumer"));
		fs.writeFileSync(
			path.join(agentDir, "extensions/consumer/index.ts"),
			`import fs from 'node:fs';export default function(pi){pi.on('session_start',()=>{for(const key of ['PI_WORKTREE_BRANCH_CONTINUATION','PI_WORKTREE_CLEANUP_CONTINUATION','PI_WORKTREE_LOOP_RETURN_CONTINUATION','PI_LOOP_HANDOFF']){if(process.env[key])fs.appendFileSync(${JSON.stringify(path.join(root, "consumed.jsonl"))},key+'\\n');delete process.env[key];}});}`,
		);
	}
	const profile = (name) =>
		fs.writeFileSync(
			path.join(agentDir, "agents", `${role}.md`),
			`---\nname: ${role}\ndescription: Reload test\nsubagent: false\ntools: [${name}_tool]\nextensions: [${options.consume ? "consumer, " : ""}${name}${options.worktree ? ", git-worktree-isolation" : ""}]\nskills: ${name === "new" ? "[fixture]" : "[]"}\n---\nUnique ${name} system prompt.\n`,
		);
	profile("old");
	const session =
		role === "main"
			? path.join(root, "saved.jsonl")
			: path.join(agentDir, "profile-sessions", role, "saved.jsonl");
	fs.mkdirSync(path.dirname(session), { recursive: true });
	let cwd = root;
	if (options.legacy) {
		const repo = path.join(root, "repo"),
			remote = path.join(root, "origin.git");
		fs.mkdirSync(repo);
		const git = (args, dir = repo) => {
			const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
			assert.equal(r.status, 0, r.stderr);
		};
		git(["init", "--bare", remote], root);
		git(["init", "-b", "main"]);
		git(["config", "user.name", "Reload test"]);
		git(["config", "user.email", "reload@example.invalid"]);
		fs.writeFileSync(path.join(repo, "tracked.txt"), "Saved checkout.\n");
		git(["add", "."]);
		git(["commit", "-m", "chore: fixture"]);
		git(["remote", "add", "origin", remote]);
		git(["push", "-u", "origin", "main"]);
		const script = `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(fileURLToPath(new URL("../extensions/_outliner/package.json", import.meta.url)))});const {createJiti}=require('jiti');const jiti=createJiti(import.meta.url);const {createLaunchPlan}=await jiti.import(${JSON.stringify(fileURLToPath(new URL("../extensions/git-worktree-isolation/git.ts", import.meta.url)))});console.log(JSON.stringify(await createLaunchPlan(${JSON.stringify(repo)},${JSON.stringify(agentDir)})));`;
		const plan = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			encoding: "utf8",
		});
		assert.equal(plan.status, 0, plan.stderr);
		options.plan = JSON.parse(plan.stdout);
		assert.ok(!options.plan.manifest.createdBranch);
		cwd = options.plan.childCwd;
	}
	const id = randomUUID(),
		timestamp = new Date().toISOString();
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	if (!options.sessionless)
		fs.writeFileSync(
			session,
			[
				{ type: "session", version: 3, id, timestamp, cwd },
				{
					type: "message",
					id: "user0001",
					parentId: null,
					timestamp,
					message: { role: "user", content: "Saved user message.", timestamp: Date.now() },
				},
				{
					type: "message",
					id: "asst0001",
					parentId: "user0001",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Saved assistant message." }],
						api: "openai-completions",
						provider: "reload-test",
						model: "fixture",
						usage,
						stopReason: "stop",
						timestamp: Date.now(),
					},
				},
			]
				.map((x) => JSON.stringify(x))
				.join("\n") + "\n",
		);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CLI_PACKAGE: resolvePiPackage(),
		TERM: "xterm-256color",
	};
	for (const key of Object.keys(env))
		if (
			key === "PI_REMOTE_MANAGED" ||
			key.startsWith("PI_WORKTREE_") ||
			key === "PI_LOOP_HANDOFF"
		)
			delete env[key];
	Object.assign(env, options.env);
	if (options.plan) env.PI_WORKTREE_SESSION_MANIFEST = options.plan.manifest.manifestPath;
	const child = spawn(
		"python3",
		[
			"-u",
			"-c",
			bridge,
			process.execPath,
			launcher,
			...(role === "main" ? ["--no-mcp"] : ["--agent", role]),
			...(options.sessionless ? ["--no-session"] : ["--session", session]),
			...(options.args || []),
		],
		{ cwd, env, stdio: ["pipe", "pipe", "pipe"] },
	);
	let output = "";
	child.stdout.on("data", (x) => (output = (output + x).slice(-15000)));
	child.stderr.on("data", (x) => (output = (output + x).slice(-15000)));
	const states = () =>
		fs.existsSync(state)
			? fs
					.readFileSync(state, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((x) => JSON.parse(x))
			: [];
	const wait = async (count) => {
		const until = Date.now() + 20000;
		while (Date.now() < until) {
			if (states().length >= count) return states()[count - 1];
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(`No state ${count}: ${output}`);
	};
	return {
		root,
		cwd,
		agentDir,
		profile,
		session,
		id,
		child,
		states,
		wait,
		get output() {
			return output;
		},
		async close() {
			child.stdin.write("/quit\r");
			await new Promise((r) => setTimeout(r, 500));
			child.kill("SIGTERM");
			await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

test(
	"native /reload rereads profile resources and resumes the same conversation",
	{ timeout: 45000 },
	async () => {
		const f = fixture();
		try {
			const first = await f.wait(1);
			assert.deepEqual(first.active, ["old_tool"]);
			f.profile("new");
			await new Promise((r) => setTimeout(r, 150));
			f.child.stdin.write("/reload\r");
			const second = await f.wait(2);
			assert.deepEqual(second.active, ["new_tool"]);
			assert.ok(!second.all.includes("old_tool"));
			assert.match(second.prompt, /Unique new system prompt/);
			assert.ok(
				second.commands.some(
					(command) => command.source === "skill" && command.name.includes("fixture"),
				),
				JSON.stringify(second.commands),
			);
			assert.equal(second.id, f.id);
			assert.equal(second.session, f.session);
			assert.equal(second.model, first.model);
			assert.equal(second.thinking, first.thinking);
			assert.notEqual(second.pid, first.pid);
			f.child.stdin.write("/reload\r");
			const third = await f.wait(3);
			assert.equal(third.pid, second.pid);
			f.profile("old");
			f.child.stdin.write("/reload\r");
			const fourth = await f.wait(4);
			assert.deepEqual(fourth.active, ["old_tool"]);
			assert.notEqual(fourth.pid, third.pid);
			assert.match(fs.readFileSync(f.session, "utf8"), /Saved user message/);
			assert.match(fs.readFileSync(f.session, "utf8"), /Saved assistant message/);
		} finally {
			await f.close();
		}
	},
);

test(
	"private profile reload retains its identity and resource isolation",
	{ timeout: 30000 },
	async () => {
		const f = fixture({ role: "private" });
		try {
			const first = await f.wait(1);
			f.profile("new");
			f.child.stdin.write("/reload\r");
			const second = await f.wait(2);
			assert.deepEqual(second.active, ["new_tool"]);
			assert.ok(!second.all.includes("old_tool"));
			assert.equal(second.session, f.session);
			assert.notEqual(first.pid, second.pid);
		} finally {
			await f.close();
		}
	},
);

test(
	"in-memory profile reload keeps the process and never saves its conversation",
	{ timeout: 30000 },
	async () => {
		const f = fixture({ sessionless: true });
		try {
			const first = await f.wait(1);
			f.profile("new");
			f.child.stdin.write("/reload\r");
			const second = await f.wait(2);
			assert.equal(second.pid, first.pid);
			assert.deepEqual(second.active, ["old_tool"]);
			assert.equal(second.session, undefined);
			assert.ok(!fs.existsSync(f.session));
			assert.ok(!fs.existsSync(path.join(f.agentDir, "sessions")));
		} finally {
			await f.close();
		}
	},
);

test(
	"invalid or missing profile resources leave the old conversation usable",
	{ timeout: 30000 },
	async () => {
		const f = fixture();
		try {
			const first = await f.wait(1);
			fs.writeFileSync(
				path.join(f.agentDir, "agents/main.md"),
				"---\nname: wrong\n---\nInvalid profile.\n",
			);
			f.child.stdin.write("/reload\r");
			const second = await f.wait(2);
			assert.equal(second.pid, first.pid);
			assert.deepEqual(second.active, ["old_tool"]);
			f.profile("new");
			const extension = path.join(f.agentDir, "extensions/new/index.ts");
			fs.renameSync(extension, extension + ".missing");
			f.child.stdin.write("/reload\r");
			const third = await f.wait(3);
			assert.equal(third.pid, first.pid);
			fs.renameSync(extension + ".missing", extension);
			f.child.stdin.write("/reload\r");
			const fourth = await f.wait(4);
			assert.deepEqual(fourth.active, ["new_tool"]);
			assert.notEqual(fourth.pid, first.pid);
		} finally {
			await f.close();
		}
	},
);

test(
	"ordinary supervised worktree continuation retains profile reload",
	{ timeout: 30000 },
	async () => {
		const f = fixture({ worktree: true });
		try {
			const first = await f.wait(1);
			f.child.stdin.write("/fixture-hop\r");
			const second = await f.wait(2);
			assert.notEqual(second.pid, first.pid);
			f.profile("new");
			f.child.stdin.write("/reload\r");
			const third = await f.wait(3);
			assert.deepEqual(third.active, ["new_tool"]);
			assert.notEqual(third.pid, second.pid);
		} finally {
			await f.close();
		}
	},
);

test(
	"name alias and regular TUI resume the exact named conversation",
	{ timeout: 30000 },
	async () => {
		const f = fixture({ args: ["-n", "Named conversation", "--tui-mode", "regular"] });
		try {
			const first = await f.wait(1);
			f.profile("new");
			f.child.stdin.write("/reload\r");
			const second = await f.wait(2);
			assert.equal(second.id, first.id);
			assert.equal(second.session, f.session);
			assert.equal(second.name, "Named conversation");
			assert.deepEqual(second.active, ["new_tool"]);
		} finally {
			await f.close();
		}
	},
);

test(
	"profile reload never replays consumed worktree or loop startup actions",
	{ timeout: 30000 },
	async () => {
		const f = fixture({
			consume: true,
			env: {
				PI_WORKTREE_BRANCH_CONTINUATION: "1",
				PI_WORKTREE_CLEANUP_CONTINUATION: "1",
				PI_WORKTREE_LOOP_RETURN_CONTINUATION: "1",
				PI_LOOP_HANDOFF: "handoff",
			},
		});
		try {
			await f.wait(1);
			const consumed = path.join(f.root, "consumed.jsonl");
			const first = fs.readFileSync(consumed, "utf8");
			assert.equal(first.trim().split("\n").length, 4);
			f.profile("new");
			f.child.stdin.write("/reload\r");
			await f.wait(2);
			assert.equal(fs.readFileSync(consumed, "utf8"), first);
		} finally {
			await f.close();
		}
	},
);

test(
	"profile replacement preserves legacy managed checkout until real quit",
	{ timeout: 30000 },
	async () => {
		const f = fixture({ legacy: true });
		try {
			const first = await f.wait(1);
			f.profile("new");
			f.child.stdin.write("/reload\r");
			const second = await f.wait(2);
			assert.equal(second.session, f.session);
			assert.notEqual(second.pid, first.pid);
			assert.ok(fs.existsSync(f.cwd));
			f.child.stdin.write("/quit\r");
			const until = Date.now() + 10000;
			while (fs.existsSync(f.cwd) && Date.now() < until)
				await new Promise((r) => setTimeout(r, 50));
			assert.ok(!fs.existsSync(f.cwd), f.output);
		} finally {
			await f.close();
		}
	},
);
