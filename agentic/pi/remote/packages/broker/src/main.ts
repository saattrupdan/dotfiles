import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { assertDeployment } from "./gates.ts";
import { createBroker } from "./server.ts";
import { ownershipRuntime, resolvePiPackage } from "../../../../profile/pi-runtime.mjs";
process.umask(0o077);
const arg = process.argv.indexOf("--config");
const config = loadConfig(arg >= 0 ? process.argv[arg + 1] : undefined);
const proof = process.argv.includes("--proof");
await ownershipRuntime(resolvePiPackage());
assertDeployment(config, proof);
if (proof) config.dataDir = path.join(config.dataDir, "proof");
const bundled = fileURLToPath(new URL("./web/", import.meta.url));
config.webDir ??= process.argv[1]?.endsWith(".mjs") ? bundled : undefined;
const { app } = await createBroker(config, { proof });
await app.listen({ host: "127.0.0.1", port: config.port });
console.log(
  `Pi Remote ${proof ? "authentication proof" : config.deploymentPolicy === "pilot" ? "live pilot" : "broker"} listening on 127.0.0.1:${config.port}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
