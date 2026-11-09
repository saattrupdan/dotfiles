import path from "node:path";
import type { Config } from "./config.ts";
import { historyInScope } from "../../../../extensions/_session_ownership/ownership.mjs";

/** Pilot visibility and admission share the native pre-open history scope. */
export function inDeploymentScope(
  config: Config,
  session: { managed: boolean; tmux?: string; sessionFile: string },
) {
  if (config.deploymentPolicy !== "pilot") return true;
  return (
    !!session.managed &&
    !!session.tmux &&
    historyInScope(session.sessionFile, path.join(config.dataDir, "native-sessions"))
  );
}
