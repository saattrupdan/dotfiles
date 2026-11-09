import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
export const ConfigSchema = z.object({
  deploymentPolicy: z.enum(["release", "pilot"]).default("release"),
  port: z.number().int().min(1024).max(65535).default(8787),
  origin: z
    .string()
    .url()
    .refine((v) => v.startsWith("https://") && new URL(v).hostname.endsWith(".ts.net")),
  home: z.string().default(os.homedir()),
  dataDir: z
    .string()
    .default(path.join(os.homedir(), "Library", "Application Support", "PiRemote")),
  agentDir: z.string().default(path.join(os.homedir(), ".pi", "agent")),
  tmux: z.string().default("/opt/homebrew/bin/tmux"),
  node: z.string().default(process.execPath),
  idleMs: z
    .number()
    .min(60000)
    .default(4 * 60 * 60 * 1000),
  webDir: z.string().optional(),
  uploadBytes: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024)
    .default(10 * 1024 * 1024),
  uploadQuotaBytes: z
    .number()
    .int()
    .positive()
    .default(512 * 1024 * 1024),
});
export type Config = z.infer<typeof ConfigSchema>;
export function loadConfig(
  file = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "PiRemote",
    "config.json",
  ),
): Config {
  return ConfigSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}
export function prepare(config: Config) {
  for (const dir of [config.dataDir, path.join(config.dataDir, "attachments")]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}
