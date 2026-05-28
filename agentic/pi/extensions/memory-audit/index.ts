/**
 * Memory audit extension — two responsibilities:
 *
 * 1. Background memory audit (turn_end): spawns the memory-audit script
 *    to process new conversation lines and save memories.
 *
 * 2. Auto-inject relevant memories (input): on each user message, performs
 *    fuzzy keyword search across all memories and prepends the top-k results
 *    to the user message. This injects memories into the conversation context
 *    without modifying the system prompt (preserving prefix caching).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const PI = join(process.env.HOME ?? "/Users/dansmart", ".pi", "agent");
const COOLDOWN_FILE = join(PI, "memories", ".audit-cooldown");
const AUDIT_SCRIPT = join(PI, "bin", "memory-audit");
const COOLDOWN_SEC = 300; // 5 minutes

// ---------------------------------------------------------------------------
// Fuzzy keyword search (same logic as memory_suggest tool, duplicated for
// self-contained injection at the input event).
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
	"a","an","the","and","or","but","in","on","at","to","for",
	"of","with","by","from","is","it","this","that","these","those",
	"was","were","been","be","have","has","had","do","does","did",
	"will","would","could","should","may","might","can","shall",
	"not","no","nor","if","then","than","too","very","just",
	"about","above","after","again","all","am","any","are",
	"as","because","before","between","both","during","each",
	"few","further","got","here","how","i","into","its","let",
	"more","most","much","my","new","now","off","once","only",
	"our","out","over","own","same","she","so","some","still",
	"such","take","them","there","they","through","under",
	"up","us","use","used","using","what","when","where",
	"which","who","whom","why","you","your",
]);

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\-_]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
		Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = Math.min(
				dp[i - 1][j] + 1,
				dp[i][j - 1] + 1,
				dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
	}
	return dp[m][n];
}

function fuzzyScore(queryTokens: string[], memoryTokens: string[]): number {
	if (queryTokens.length === 0) return 0;
	let score = 0;
	let exactMatches = 0;
	for (const qt of queryTokens) {
		let bestExact = 0;
		let bestFuzzy = 0;
		for (const mt of memoryTokens) {
			if (qt === mt) {
				bestExact = Math.max(bestExact, 1);
			} else {
				const dist = levenshtein(qt, mt);
				const maxLen = Math.max(qt.length, mt.length);
				const sim = maxLen === 0 ? 0 : 1 - dist / maxLen;
				if (sim > 0.7) {
					bestFuzzy = Math.max(bestFuzzy, sim * 0.5);
				}
			}
		}
		if (bestExact > 0) {
			exactMatches++;
			score += bestExact;
		} else if (bestFuzzy > 0) {
			score += bestFuzzy;
		}
	}
	if (exactMatches > 0) {
		score *= (1 + exactMatches * 0.3);
	}
	return score;
}

interface MemoryDoc {
	name: string;
	description: string;
	body: string;
	scope: "system" | "project";
	filePath: string;
}

function parseFrontmatter(content: string): { meta: { name?: string; description?: string }; body: string } {
	if (!content.startsWith("---\n")) {
		return { meta: {}, body: content };
	}
	const end = content.indexOf("\n---\n", 4);
	if (end === -1) {
		return { meta: {}, body: content };
	}
	const block = content.slice(4, end);
	const body = content.slice(end + 5);
	const meta: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const m = line.match(/^(name|description):\s*(.*)$/);
		if (m) {
			meta[m[1]] = m[2].trim();
		}
	}
	return { meta: { name: meta.name, description: meta.description ?? "" }, body };
}

function listMemories(scope: "system" | "project", cwd: string): MemoryDoc[] {
	const dir = scope === "system"
		? join(PI, "memories", "system")
		: (() => {
			try {
				const root = childProcess.execSync("git rev-parse --show-toplevel", { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
				return join(PI, "memories", "projects", crypto.createHash("sha1").update(root).digest("hex").slice(0, 10));
			} catch {
				return join(PI, "memories", "projects", "root-" + crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 10));
			}
		})();

	if (!existsSync(dir)) return [];
	const docs: MemoryDoc[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md") || file === "MEMORY.md") continue;
		const filePath = join(dir, file);
		try {
			const raw = rf(filePath, "utf-8");
			const { meta, body } = parseFrontmatter(raw);
			docs.push({
				name: basename(file, ".md"),
				description: meta.description ?? "",
				body,
				scope,
				filePath,
			});
		} catch {
			docs.push({ name: basename(file, ".md"), description: "", body: "", scope, filePath });
		}
	}
	return docs;
}

function searchMemories(query: string, topK: number): string {
	const allDocs = [
		...listMemories("system", process.cwd()),
		...listMemories("project", process.cwd()),
	];
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return "";

	const scored = allDocs.map((doc) => {
		const nameTokens = tokenize(doc.name);
		const descTokens = tokenize(doc.description);
		const bodyTokens = tokenize(doc.body);
		const nameScore = fuzzyScore(queryTokens, nameTokens) * 3;
		const descScore = fuzzyScore(queryTokens, descTokens) * 1.5;
		const bodyScore = fuzzyScore(queryTokens, bodyTokens);
		return { ...doc, score: nameScore + descScore + bodyScore };
	});

	const top = scored
		.filter((m) => m.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, topK);

	if (top.length === 0) return "";

	const lines = top.map(
		(m) => `- \`${m.scope}/${m.name}\` (${m.score.toFixed(2)}) — ${m.description}${m.body ? "\n" + m.body.trim().split("\n").slice(0, 2).map(l => "  " + l).join("\n") : ""}`,
	);

	return `Relevant memories:\n\n${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Background memory audit (turn_end)
// ---------------------------------------------------------------------------

function touchCooldown(): boolean {
	try {
		const now = Date.now();
		if (existsSync(COOLDOWN_FILE)) {
			const last = parseInt(readFileSync(COOLDOWN_FILE, "utf8").trim(), 10);
			if (!isNaN(last) && now - last < COOLDOWN_SEC * 1000) {
				return false;
			}
		}
		writeFileSync(COOLDOWN_FILE, String(now));
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Per-session dedup store — survives hot-reloads within a session.
// Each conversation (session) gets its own dedup file.
const INJECTED_DIR = join(PI, "memories", ".injected-slugs");

function injectedFile(sessionId: string): string {
	fs.mkdirSync(INJECTED_DIR, { recursive: true });
	return join(INJECTED_DIR, sessionId + ".json");
}

function saveInjectedSlugs(sessionId: string, slugs: Set<string>) {
	try {
		writeFileSync(injectedFile(sessionId), JSON.stringify([...slugs]));
	} catch { /* ignore */ }
}

export default function (pi: ExtensionAPI) {
	const MAX_INJECT = 5; // max memories to inject per message

	// Background memory audit — fires after each turn
	// Auto-inject relevant memories — fires after each assistant message
	const injected = new Set<string>();

	function injectAssistantMemories(message: string, sessionId: string) {
		if (!message || message.trim().length < 3) return;
		const result = searchMemories(message, MAX_INJECT);
		if (!result) return;
		// Extract memory slugs from result to deduplicate
		const slugs: string[] = [];
		for (const line of result.trim().split("\n")) {
			const m = line.match(/`([^`]+)`/);
			if (m) slugs.push(m[1]);
		}
		for (const slug of slugs) {
			if (!injected.has(slug)) {
				injected.add(slug);
			} else {
				// Already injected in this session
				return undefined;
			}
		}
		saveInjectedSlugs(sessionId, injected);
		return { action: "transform" as const, text: result };
	}

	pi.on("turn_end", async (event, ctx) => {
		// Background audit
		if (!touchCooldown()) {
			return;
		}

		const { exec } = await import("node:child_process");
		exec(
			`nohup bash -c '${AUDIT_SCRIPT}' </dev/null >/dev/null 2>&1 &`,
			() => {},
		);

		// Memory injection — only for assistant/tool messages,
		// catches multi-turn assistant sequences before user boundary.
		const sessionId = ctx.sessionManager?.getSessionId() ?? "unknown";
		if (event.message?.role === "assistant") {
			const content = typeof event.message.content === "string"
				? event.message.content
				: JSON.stringify(event.message.content);
			injectAssistantMemories(content, sessionId);
		}
		if (event.message?.role === "toolResult") {
			const content = typeof event.message.content === "string"
				? event.message.content
				: JSON.stringify(event.message.content);
			injectAssistantMemories(content, sessionId);
		}
		return undefined;
	});

	// Auto-inject relevant memories — fires on each user message
	pi.on("input", async (event, ctx) => {
		const query = event.text;
		if (!query || query.trim().length < 3) {
			return { action: "continue" };
		}

		const result = searchMemories(query, MAX_INJECT);
		if (!result) {
			return { action: "continue" };
		}

		const sessionId = ctx.sessionManager?.getSessionId() ?? "unknown";
		// Deduplicate against already-injected slugs
		const slugs: string[] = [];
		for (const line of result.trim().split("\n")) {
			const m = line.match(/`([^`]+)`/);
			if (m) slugs.push(m[1]);
		}
		for (const slug of slugs) {
			if (!injected.has(slug)) {
				injected.add(slug);
			} else {
				return { action: "continue" };
			}
		}
		saveInjectedSlugs(sessionId, injected);

		return {
			action: "transform",
			text: `${result}\n\n---\n${query}`,
		};
	});
}
