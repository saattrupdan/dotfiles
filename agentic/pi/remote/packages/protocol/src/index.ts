import { z } from "zod";
export const VERSION = 1;
export const Id = z.string().uuid();
export const NativeSessionId = z.string().min(1).max(4096);
export const Command = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("message"),
    text: z.string().max(100000),
    images: z.array(Id).max(8).default([]),
  }),
  z.object({ action: z.literal("stop_run") }),
  z.object({ action: z.literal("stop_session") }),
  z.object({ action: z.literal("rename"), name: z.string().trim().min(1).max(160) }),
  z.object({
    action: z.literal("model"),
    provider: z.string().max(100),
    model: z.string().max(200),
  }),
  z.object({
    action: z.literal("thinking"),
    level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
  }),
  z.object({ action: z.literal("compact") }),
  z.object({
    action: z.literal("slash"),
    name: z.string().regex(/^(?:skill:)?[a-z][a-z0-9-]*$/),
    args: z.string().max(10000),
  }),
  z.object({
    action: z.literal("answer"),
    promptId: Id,
    answer: z.union([
      z.string().max(20000),
      z.array(z.string().max(1000)).max(100),
      z.boolean(),
    ]),
  }),
]);
export const Envelope = z.object({
  version: z.literal(VERSION),
  commandId: Id,
  sessionId: Id,
  epoch: z.number().int().positive(),
  command: Command,
  retryOf: Id.optional(),
});
export const NativeEnvelope = Envelope.extend({ sessionId: NativeSessionId });
export type Envelope = z.infer<typeof Envelope>;
export type Command = z.infer<typeof Command>;
export const CommandStatus = z.enum([
  "received",
  "forwarded",
  "accepted_by_owner",
  "persisted",
  "rejected",
  "delivery_unknown",
]);
export type CommandStatus = z.infer<typeof CommandStatus>;
export const Prompt = z.object({
  id: Id,
  title: z.string().max(10000),
  options: z.array(z.string()).optional(),
  multiSelect: z.boolean().optional(),
  deadline: z.number(),
  state: z.enum(["pending", "resolved", "expired"]),
});
export type Prompt = z.infer<typeof Prompt>;
export const Registration = z.object({
  version: z.literal(VERSION),
  instanceId: Id,
  sessionId: NativeSessionId,
  nativeSessionEnvelope: z.literal(1).optional(),
  sessionFile: z.string(),
  cwd: z.string(),
  name: z.string().max(1000),
  pid: z.number().int().positive(),
  managed: z.boolean(),
  tmux: z.string().optional(),
  model: z.string(),
  thinking: z.string(),
  capabilities: z.array(
    z.object({
      name: z.string(),
      supported: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
  idle: z.boolean(),
  loop: z.boolean(),
  prompt: Prompt.optional(),
});
export type Registration = z.infer<typeof Registration>;
export interface Session extends Registration {
  workingMessage?: string;
  runtimeCwd?: string;
  nativeSessionId?: string;
  controlBlockedReason?: string;
  recoveryBlockedReason?: string;
  epoch: number;
  sequence: number;
  state: string;
  lastActivity: number;
}
export interface SessionFolder {
  cwd: string;
  count: number;
  lastActivity: number;
}
export interface StreamEvent {
  version: 1;
  type: string;
  sessionId?: string;
  sequence?: number;
  data: unknown;
}
export const DeviceName = z.string().trim().min(1).max(80);
export const CreateSession = z.object({ cwd: z.string().min(1).max(4096) });
export const Answer = z.object({
  promptId: Id,
  answer: z.union([z.string(), z.array(z.string()), z.boolean()]),
});
export class RemoteError extends Error {
  code: string;
  statusCode: number;
  constructor(code: string, statusCode = 400) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface HistoryPage {
  anchorFound?: boolean;
  anchoredOlder?: string | null;
  messages: Record<string, unknown>[];
  revision: string;
  older: string | null;
  truncated?: boolean;
}
