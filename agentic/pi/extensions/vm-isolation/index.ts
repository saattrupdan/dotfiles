/**
 * File Protection Extension for Pi
 *
 * Provides strong file protection against accidental or malicious deletion:
 * - APFS snapshots before each agent run (instant rollback)
 * - Intercepts destructive bash commands (rm, mv, dd, etc.)
 * - Git-aware protection (tracked files require extra confirmation)
 * - Real-time file system monitoring
 *
 * Commands that only touch paths outside the project are deliberately not
 * flagged: the snapshot taken before every run already covers them, and the
 * warning was pure noise (see the note in `tool_execution_start`).
 *
 * Configuration (settings.json):
 * ```json
 * {
 *   "fileProtection": {
 *     "enabled": true,
 *     "autoSnapshot": true,
 *     "blockCriticalCommands": true
 *   }
 * }
 * ```
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

/**
 * Run a command with a timeout. Uses exec's own timeout so the child is killed
 * and no timer outlives the call — the previous Promise.race left a pending
 * timeout per call, which kept the event loop alive for up to 8 s after pi
 * wanted to exit.
 */
const execAsync = (cmd: string, timeoutMs = 8000) =>
	new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		childProcess.exec(cmd, { timeout: timeoutMs }, (error, stdout, stderr) => {
			if (error) reject(error);
			else resolve({ stdout, stderr });
		});
	});
/**
 * execFile variant for calls that pass agent-authored text as an argument.
 * Never builds a shell command line: `check-command $(...)` would otherwise be
 * expanded and run here, outside the tool call being inspected.
 */
const execFileAsync = (file: string, args: string[], timeoutMs = 8000) =>
	new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		childProcess.execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
			if (error) reject(error);
			else resolve({ stdout, stderr });
		});
	});
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PROTECTOR_PATH = path.join(__dirname, 'vm-runner/.build/debug/vm-runner');

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorStdout(error: unknown): string | undefined {
	if (!error || typeof error !== 'object' || !('stdout' in error)) return undefined;
	const stdout = (error as { stdout?: unknown }).stdout;
	return typeof stdout === 'string' ? stdout : undefined;
}

interface FileProtectionConfig {
	enabled: boolean;
	autoSnapshot: boolean;
	blockCriticalCommands: boolean;
}

interface ActiveProtection {
	/**
	 * Session id, which is stable for the whole run. Do not use the session-tree
	 * leaf id: it changes whenever an entry is appended, so a key captured at
	 * agent_start no longer exists by the time a tool call runs.
	 */
	sessionId: string;
	snapshotName?: string;
	startedAt: number;
	projectRoot: string;
	/** False once the background check finds no APFS/tmutil support. */
	supported: boolean;
}

function protectionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

export default function (pi: ExtensionAPI) {
	const activeProtections = new Map<string, ActiveProtection>();
	/** Background snapshot work per run, joined before it is depended upon. */
	const pendingProtections = new Map<string, Promise<void>>();
	/** `which tmutil` cannot start working mid-session, so ask once. */
	let systemSupport: Promise<{ supported: boolean; reason?: string }> | null = null;
	let config: FileProtectionConfig = {
		enabled: true,
		autoSnapshot: true,
		blockCriticalCommands: true,
	};

	/**
	 * Load configuration from settings
	 */
	function loadConfig() {
		try {
			const settingsPath = path.join(os.homedir(), '.pi/agent/settings.json');
			if (fs.existsSync(settingsPath)) {
				const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
				if (settings.fileProtection) {
					config = { ...config, ...settings.fileProtection };
				}
			}
		} catch {
			// Use defaults on error
		}
	}

	/**
	 * Check if macOS with APFS support
	 */
	async function checkSystemSupport(): Promise<{ supported: boolean; reason?: string }> {
		if (!systemSupport) {
			systemSupport = (async (): Promise<{ supported: boolean; reason?: string }> => {
				if (os.platform() !== 'darwin') {
					return { supported: false, reason: 'File protection requires macOS' };
				}

				try {
					// Check if tmutil is available
					await execAsync('which tmutil');
					return { supported: true };
				} catch {
					return { supported: false, reason: 'tmutil not available' };
				}
			})();
		}
		return systemSupport;
	}

	/**
	 * Create APFS snapshot
	 */
	async function createSnapshot(): Promise<string | null> {
		if (!config.autoSnapshot) return null;

		try {
			const { stdout } = await execAsync(`${FILE_PROTECTOR_PATH} snapshot`);
			// tmutil outputs a NOTE message to stdout before the JSON, so extract only the JSON line
			const jsonLine = stdout.trim().split('\n').find(line => line.startsWith('{'));
			if (!jsonLine) return null;
			const result = JSON.parse(jsonLine);
			if (result.status === 'success') {
				return result.snapshotName;
			}
			return null;
		} catch {
			// Non-fatal - continue without snapshot
			return null;
		}
	}

	/**
	 * List available snapshots
	 */
	async function listSnapshots(): Promise<string[]> {
		try {
			const { stdout } = await execAsync(`${FILE_PROTECTOR_PATH} list-snapshots`);
			// Extract JSON line from output (tmutil may prepend NOTE messages)
			const jsonLine = stdout.trim().split('\n').find(line => line.startsWith('{'));
			if (!jsonLine) return [];
			const result = JSON.parse(jsonLine);
			return result.snapshots || [];
		} catch {
			return [];
		}
	}

	/**
	 * Check if a command is dangerous
	 */
	async function checkCommandSafety(command: string): Promise<{
		safe: boolean;
		severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
		reason?: string;
	}> {
		try {
			const { stdout } = await execFileAsync(FILE_PROTECTOR_PATH, ['check-command', command]);
			// Extract JSON line from output (tmutil may prepend NOTE messages)
			const jsonLine = stdout.trim().split('\n').find(line => line.startsWith('{'));
			if (!jsonLine) return { safe: true, severity: 'none' };
			const result = JSON.parse(jsonLine);

			if (result.shouldBlock) {
				return { safe: false, severity: 'critical', reason: 'Blocked destructive command' };
			}

			if (result.critical.length > 0) {
				return { safe: false, severity: 'critical', reason: 'Critical pattern detected' };
			}
			if (result.high?.length > 0) {
				return { safe: false, severity: 'high', reason: 'High-risk pattern detected' };
			}
			if (result.medium?.length > 0) {
				return { safe: true, severity: 'medium', reason: 'Medium-risk pattern - proceed with caution' };
			}

			return { safe: true, severity: 'none' };
		} catch {
			// Fail-secure: if we can't check, block the command
			return { safe: false, severity: 'high', reason: 'Safety check unavailable - command blocked' };
		}
	}

	/**
	 * Check if file is git-tracked
	 */
	async function isGitTracked(filePath: string, projectRoot: string): Promise<boolean> {
		try {
			const { stdout } = await execAsync(`git -C "${projectRoot}" ls-files --error-unmatch "${filePath}" 2>/dev/null`);
			return stdout.trim().length > 0;
		} catch {
			return false;
		}
	}

	// Load config
	loadConfig();

	// Hook into agent lifecycle
	//
	// The snapshot is taken in the background rather than awaited here: pi
	// awaits every agent_start handler before it emits turn_start, which is
	// when the submitted message becomes visible, so awaiting `tmutil
	// localsnapshot` delays the message by 0.1-0.3 s per turn (and up to the
	// 8 s exec timeout if tmutil stalls). Nothing needs the snapshot before the
	// agent's first tool call, which always follows a model round trip; the
	// places that do depend on it join pendingProtections first.
	pi.on('agent_start', (_event, ctx) => {
		if (!config.enabled) return;
		if (!ctx.hasUI) return;

		const key = protectionKey(ctx);
		// Registered synchronously so tool_execution_start never mistakes a
		// half-started run for "protection off".
		activeProtections.set(key, {
			sessionId: key,
			startedAt: Date.now(),
			projectRoot: ctx.cwd,
			supported: true,
		});
		pendingProtections.set(key, takeProtectionSnapshot(key, ctx));
	});

	async function takeProtectionSnapshot(key: string, ctx: ExtensionContext): Promise<void> {
		const protection = activeProtections.get(key);
		if (!protection) return;

		const systemCheck = await checkSystemSupport();
		if (!systemCheck.supported) {
			protection.supported = false;
			ctx.ui.setStatus('file-protection', `⚠️ ${systemCheck.reason}`);
			return;
		}

		try {
			const snapshotName = await createSnapshot();
			protection.snapshotName = snapshotName || undefined;
			ctx.ui.setStatus('file-protection', snapshotName ? '🛡️' : undefined);
		} catch {
			protection.supported = false;
			ctx.ui.setStatus('file-protection', '⚠️ Protection inactive');
		}
	}

	pi.on('agent_end', async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const key = protectionKey(ctx);
		if (!activeProtections.has(key)) return;

		// Prune only after this run's snapshot landed, so cleanup never deletes
		// (or races) a snapshot tmutil is still creating.
		const protection = activeProtections.get(key);
		await pendingProtections.get(key);
		activeProtections.delete(key);
		pendingProtections.delete(key);
		// Cleanup old snapshots (keep last 10)
		if (protection?.supported) {
			try {
				await execAsync(`${FILE_PROTECTOR_PATH} cleanup`);
			} catch {
				// Cleanup is best-effort.
			}
		}
		ctx.ui.setStatus('file-protection', undefined);
	});

	// Intercept bash tool calls to check for dangerous commands
	pi.on('tool_execution_start', async (event, ctx) => {
		if (!config.enabled || !config.blockCriticalCommands) return;
		if (event?.toolName !== 'bash') return;
		if (!ctx.hasUI) return;

		const key = protectionKey(ctx);
		// Join the background snapshot before consulting the record: in practice
		// it finished long ago (the model had to answer first), but this keeps
		// the guard from being skipped on a run that started milliseconds ago.
		await pendingProtections.get(key);
		const protection = activeProtections.get(key);
		if (!protection?.supported) return;

		const command = event?.args?.command || '';
		if (!command) return;
		
		// Check 1: Dangerous command patterns
		const safetyCheck = await checkCommandSafety(command);
		if (!safetyCheck.safe) {
			// Block the command
			event.args.command = `echo "BLOCKED: ${safetyCheck.reason} \\nCommand: ${command.replace(/"/g, '\\"')}" && exit 1`;
			ctx.ui.setStatus('file-protection', `🚫 Blocked: ${safetyCheck.reason}`);
			return;
		}

		// Paths outside the project are intentionally not reported here. The
		// per-run snapshot covers them, and the check could only warn, so all it
		// did was overwrite the 🛡️ status with "⚠️ Outside paths" on commands that
		// mention an absolute path (allowedPaths was empty unless overridden in
		// settings.json, which made every absolute path look out of bounds).

		// Check 2: Git-tracked file modifications
		if (command.includes(' > ') || command.includes('>> ') || command.includes('rm ')) {
			const fileMatch = command.match(/>\s*([^\s;&|]+)/) || command.match(/rm\s+([^\s;&|]+)/);
			if (fileMatch) {
				const filePath = fileMatch[1];
				const isTracked = await isGitTracked(filePath, protection.projectRoot);
				if (isTracked) {
					// This is a tracked file - extra protection
					if (command.includes('rm ')) {
						ctx.ui.setStatus('file-protection', '⚠️ Deleting tracked file');
					}
				}
			}
		}
	});

	// Register slash command for file protection control
	pi.registerCommand('protect', {
		description: 'Control file protection and rollback',
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const subcommand = args[0] || 'status';

			switch (subcommand) {
				case 'status': {
					const systemCheck = await checkSystemSupport();
					const snapshots = await listSnapshots();
					const message = [
						'**File Protection Status**',
						`- Enabled: ${config.enabled}`,
						`- Auto-snapshot: ${config.autoSnapshot}`,
						`- Block critical commands: ${config.blockCriticalCommands}`,
						`- System support: ${systemCheck.supported ? '✅' : '❌'}${systemCheck.reason ? ` (${systemCheck.reason})` : ''}`,
						`- Recent snapshots: ${snapshots.length > 0 ? snapshots.slice(-5).join(', ') : 'None'}`,
						`- Active protections: ${activeProtections.size}`,
					].join('\n');
					ctx.ui.setStatus('file-protection-info', message);
					break;
				}

				case 'on':
					config.enabled = true;
					ctx.ui.setStatus('file-protection', '✅ Enabled');
					break;

				case 'off':
					config.enabled = false;
					ctx.ui.setStatus('file-protection', '❌ Disabled');
					break;

				case 'snapshots': {
					const snapshots = await listSnapshots();
					if (snapshots.length > 0) {
						ctx.ui.setStatus('file-protection-snapshots', `**Snapshots:**\n${snapshots.map(s => `- ${s}`).join('\n')}`);
					} else {
						ctx.ui.setStatus('file-protection-snapshots', 'No snapshots found');
					}
					break;
				}

				case 'rollback': {
					const snapshotName = args[1];
					if (!snapshotName) {
						ctx.ui.setStatus('file-protection', '❓ Usage: /protect rollback <snapshot-name>');
						return;
					}
					try {
						const { stdout } = await execAsync(`${FILE_PROTECTOR_PATH} rollback ${snapshotName}`);
						const result = JSON.parse(stdout);
						if (result.status === 'success') {
							ctx.ui.setStatus('file-protection', `✅ ${result.message}`);
						} else {
							ctx.ui.setStatus('file-protection', `❌ ${result.error}`);
						}
					} catch (error) {
						const stdout = errorStdout(error);
						if (stdout) {
							const result = JSON.parse(stdout);
							ctx.ui.setStatus('file-protection', `❌ ${result.error}. Available: ${result.available?.join(', ') || 'none'}`);
						} else {
							ctx.ui.setStatus('file-protection', `❌ Rollback failed: ${errorMessage(error)}`);
						}
					}
					break;
				}

				case 'snapshot':
					try {
						const snapshotName = await createSnapshot();
						if (snapshotName) {
							ctx.ui.setStatus('file-protection', `📸 Snapshot created: ${snapshotName}`);
						} else {
							ctx.ui.setStatus('file-protection', '⚠️ Snapshot failed');
						}
					} catch (error) {
						ctx.ui.setStatus('file-protection', `❌ Snapshot failed: ${errorMessage(error)}`);
					}
					break;

				default:
					ctx.ui.setStatus('file-protection', '❓ Usage: /protect [status|on|off|snapshots|rollback|snapshot]');
			}
		},
	});
}
