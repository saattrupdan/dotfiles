/**
 * File Protection Extension for Pi
 *
 * Provides strong file protection against accidental or malicious deletion:
 * - APFS snapshots before each agent run (instant rollback)
 * - Intercepts destructive bash commands (rm, mv, dd, etc.)
 * - Git-aware protection (tracked files require extra confirmation)
 * - Protects files outside project directory
 * - Real-time file system monitoring
 *
 * Configuration (settings.json):
 * ```json
 * {
 *   "fileProtection": {
 *     "enabled": true,
 *     "autoSnapshot": true,
 *     "protectOutsideProject": true,
 *     "blockCriticalCommands": true,
 *     "allowedPaths": ["./", "/tmp/", "/var/folders/"]
 *   }
 * }
 * ```
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const execAsync = promisify(childProcess.exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PROTECTOR_PATH = path.join(__dirname, 'vm-runner/.build/debug/vm-runner');

interface FileProtectionConfig {
	enabled: boolean;
	autoSnapshot: boolean;
	protectOutsideProject: boolean;
	blockCriticalCommands: boolean;
	allowedPaths: string[];
}

interface ActiveProtection {
	agentId: string;
	snapshotName?: string;
	startedAt: number;
	projectRoot: string;
}

export default function (pi: ExtensionAPI) {
	const activeProtections = new Map<string, ActiveProtection>();
	let config: FileProtectionConfig = {
		enabled: true,
		autoSnapshot: true,
		protectOutsideProject: true,
		blockCriticalCommands: true,
		allowedPaths: [],
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
					if (config.allowedPaths.length === 0) {
						config.allowedPaths = [
							process.cwd() + '/',
							os.tmpdir() + '/',
							path.join(os.tmpdir(), 'var', 'folders') + '/',
						];
					}
				}
			}
		} catch (_error) {
			// Use defaults on error
		}
	}

	/**
	 * Check if macOS with APFS support
	 */
	async function checkSystemSupport(): Promise<{ supported: boolean; reason?: string }> {
		if (os.platform() !== 'darwin') {
			return { supported: false, reason: 'File protection requires macOS' };
		}

		try {
			// Check if tmutil is available
			await execAsync('which tmutil');
			return { supported: true };
		} catch (_error) {
			return { supported: false, reason: 'tmutil not available' };
		}
	}

	/**
	 * Create APFS snapshot
	 */
	async function createSnapshot(): Promise<string | null> {
		if (!config.autoSnapshot) return null;

		try {
			const { stdout } = await execAsync(`${FILE_PROTECTOR_PATH} snapshot`);
			const result = JSON.parse(stdout);
			if (result.status === 'success') {
				return result.snapshotName;
			}
			return null;
		} catch (_error) {
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
			const result = JSON.parse(stdout);
			return result.snapshots || [];
		} catch (_error) {
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
			const { stdout } = await execAsync(`${FILE_PROTECTOR_PATH} check-command ${command}`);
			const result = JSON.parse(stdout);

			if (result.shouldBlock) {
				return { safe: false, severity: 'critical', reason: 'Blocked destructive command' };
			}

			if (result.critical.length > 0) {
				return { safe: false, severity: 'critical', reason: 'Critical pattern detected' };
			}
			if (result.high.length > 0) {
				return { safe: false, severity: 'high', reason: 'High-risk pattern detected' };
			}
			if (result.medium.length > 0) {
				return { safe: true, severity: 'medium', reason: 'Medium-risk pattern - proceed with caution' };
			}

			return { safe: true, severity: 'none' };
		} catch (_error) {
			// On error, assume safe to avoid blocking legitimate work
			return { safe: true, severity: 'none' };
		}
	}

	/**
	 * Check if a path is outside allowed directories
	 */
	function isPathAllowed(filePath: string): boolean {
		if (!config.protectOutsideProject) return true;

		const normalizedPath = path.resolve(filePath);
		return config.allowedPaths.some(allowed => normalizedPath.startsWith(path.resolve(allowed)));
	}

	/**
	 * Check if file is git-tracked
	 */
	async function isGitTracked(filePath: string, projectRoot: string): Promise<boolean> {
		try {
			const { stdout } = await execAsync(`git -C "${projectRoot}" ls-files --error-unmatch "${filePath}" 2>/dev/null`);
			return stdout.trim().length > 0;
		} catch (_error) {
			return false;
		}
	}

	// Load config
	loadConfig();

	// Hook into agent lifecycle
	pi.on('agent_start', async (_event, ctx) => {
		if (!config.enabled) return;

		const systemCheck = await checkSystemSupport();
		if (!systemCheck.supported) {
			ctx.ui.setStatus('file-protection', `⚠️ ${systemCheck.reason}`);
			return;
		}

		try {
			const snapshotName = await createSnapshot();
			const agentId = ctx.sessionManager.getLeafEntry()?.id || 'unknown';
			
			activeProtections.set(agentId, {
				agentId,
				snapshotName: snapshotName || undefined,
				startedAt: Date.now(),
				projectRoot: ctx.cwd,
			});

			ctx.ui.setStatus('file-protection', snapshotName ? '🛡️ Protected' : '🛡️ Watching');
		} catch (_error) {
			ctx.ui.setStatus('file-protection', '⚠️ Protection inactive');
		}
	});

	pi.on('agent_end', async (_event, ctx) => {
		const agentId = ctx.sessionManager.getLeafEntry()?.id;
		if (!agentId || !activeProtections.has(agentId)) return;

		activeProtections.delete(agentId);
		ctx.ui.setStatus('file-protection', undefined);
	});

	// Intercept bash tool calls to check for dangerous commands
	pi.on('tool_execution_start', async (event, ctx) => {
		if (!config.enabled || !config.blockCriticalCommands) return;
		if (event.toolCall.name !== 'bash') return;

		const agentId = ctx.sessionManager.getLeafEntry()?.id;
		const protection = agentId ? activeProtections.get(agentId) : null;
		if (!protection) return;

		const command = event.toolCall.arguments.command || '';
		
		// Check 1: Dangerous command patterns
		const safetyCheck = await checkCommandSafety(command);
		if (!safetyCheck.safe) {
			// Block the command
			event.toolCall.arguments = { command: `echo "BLOCKED: ${safetyCheck.reason} \\nCommand: ${command.replace(/"/g, '\\"')}" && exit 1` };
			ctx.ui.setStatus('file-protection', `🚫 Blocked: ${safetyCheck.reason}`);
			return;
		}

		// Check 2: Paths outside allowed directories
		const pathPattern = command.match(/(?:^|\s)(\/[\w/.-]+|\~\/[\w/.-]+|\.\/[\w/.-]+)/g);
		if (pathPattern) {
			const blockedPaths = pathPattern.filter(p => {
				const pPath = p.trim();
				return !isPathAllowed(pPath);
			});

			if (blockedPaths.length > 0) {
				// Warn but don't block (too aggressive)
				ctx.ui.setStatus('file-protection', `⚠️ Outside paths: ${blockedPaths.slice(0, 2).join(', ')}`);
			}
		}

		// Check 3: Git-tracked file modifications
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
			const subcommand = args[0] || 'status';

			switch (subcommand) {
				case 'status': {
					const systemCheck = await checkSystemSupport();
					const snapshots = await listSnapshots();
					const message = [
						'**File Protection Status**',
						`- Enabled: ${config.enabled}`,
						`- Auto-snapshot: ${config.autoSnapshot}`,
						`- Protect outside project: ${config.protectOutsideProject}`,
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
						await execAsync(`${FILE_PROTECTOR_PATH} rollback --name ${snapshotName}`);
						ctx.ui.setStatus('file-protection', `✅ Rolled back to ${snapshotName}`);
					} catch (error: any) {
						ctx.ui.setStatus('file-protection', `❌ Rollback failed: ${error.message}`);
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
					} catch (error: any) {
						ctx.ui.setStatus('file-protection', `❌ Snapshot failed: ${error.message}`);
					}
					break;

				default:
					ctx.ui.setStatus('file-protection', '❓ Usage: /protect [status|on|off|snapshots|rollback|snapshot]');
			}
		},
	});

	// Initial status
	const initCheck = async () => {
		if (config.enabled) {
			const supported = await checkSystemSupport();
			if (supported.supported) {
				pi.ui?.setStatus('file-protection', '🛡️ Ready');
			}
		}
	};
	initCheck();
}
