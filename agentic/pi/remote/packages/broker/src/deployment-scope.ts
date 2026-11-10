import path from "node:path";
import type { Config } from "./config.ts";
import { RemoteError } from "../../protocol/src/index.ts";
import {
  historyInScope,
  laptopActivated,
  pendingMigration,
} from "../../../../extensions/_session_ownership/ownership.mjs";

export function controlBlockReason(config: Config) {
  const root = path.join(config.dataDir, "ownership");
  if (
    config.deploymentPolicy === "pilot" &&
    config.pilotScope === "laptop-main" &&
    !laptopActivated(root)
  )
    return "laptop_activation_required";
  if (pendingMigration(root)) return "laptop_restart_required";
  return undefined;
}
export function assertControlReady(config: Config) {
  const reason = controlBlockReason(config);
  if (reason) throw new RemoteError(reason, 409);
}

/** The expanded pilot admits main histories without admitting private profiles. */
export function sessionRoots(config: Config) {
  return [
    path.join(config.agentDir, "sessions"),
    path.join(config.dataDir, "native-sessions"),
    ...config.sessionDirectories,
  ];
}

export function mainHistory(config: Config, file: string) {
  return (
    !historyInScope(file, path.join(config.agentDir, "profile-sessions")) &&
    sessionRoots(config).some((root) => historyInScope(file, root))
  );
}
export function inDeploymentScope(
  config: Config,
  session: { managed: boolean; tmux?: string; sessionFile: string },
) {
  if (config.deploymentPolicy !== "pilot") return true;
  if (config.pilotScope === "laptop-main")
    return mainHistory(config, session.sessionFile);
  return (
    !!session.managed &&
    !!session.tmux &&
    historyInScope(session.sessionFile, path.join(config.dataDir, "native-sessions"))
  );
}
