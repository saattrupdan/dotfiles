import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const IDLE_NS = 60_000_000_000n;
type RegistryReader = (args: readonly string[]) => Promise<string>;

async function readRegistry(args: readonly string[]): Promise<string> {
  const { stdout } = await run("/usr/sbin/ioreg", args, {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 256 * 1024,
  });
  return stdout;
}

function consoleState(output: string): "locked" | "console" | "unknown" {
  const users = output.match(/^[\s|]*"IOConsoleUsers"\s*=\s*\((.*)\)\s*$/m)?.[1];
  if (!users) return "unknown";
  const active = [...users.matchAll(/\{([^{}]*)\}/g)].filter((match) =>
    /"kCGSSessionOnConsoleKey"\s*=\s*Yes\b/.test(match[1]!),
  );
  if (active.length !== 1) return "unknown";
  return /"CGSSessionScreenIsLocked"\s*=\s*Yes\b/.test(active[0]![1]!)
    ? "locked"
    : "console";
}

/** Read aggregate Mac presence only; unknown probes keep phone alerts available. */
export async function phoneNotificationsAllowed(
  query: RegistryReader = readRegistry,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== "darwin") return true;
  try {
    const state = consoleState(await query(["-n", "Root", "-d1", "-l"]));
    if (state !== "console") return true;
    const idle = await query(["-r", "-c", "IOHIDSystem", "-d1", "-l"]);
    const matches = [...idle.matchAll(/^[\s|]*"HIDIdleTime"\s*=\s*(\d{1,20})\s*$/gm)];
    if (matches.length !== 1) return true;
    return BigInt(matches[0]![1]!) >= IDLE_NS;
  } catch {
    return true;
  }
}
