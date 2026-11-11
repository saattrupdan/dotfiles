import { WorkingStatus } from "../../../../extensions/_working-status/status.ts";
import { sessionReference } from "./session-reference.ts";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  Envelope,
  Registration,
  type Session,
  type StreamEvent,
} from "../../protocol/src/index.ts";
import type { Config } from "./config.ts";
import {
  inDeploymentScope,
  canonicalPath,
  registeredWorkingDirectory,
} from "./deployment-scope.ts";
import { Store, token } from "./store.ts";
import type { ToolProgress } from "../../../../extensions/_tool-display/block-types.ts";
export class Connections {
  private failures = new Map<string, boolean>();
  private previews = new Map<string, Map<string, ToolProgress>>();
  progress(session: Session) {
    return this.isConnected(session) && !session.idle
      ? [...(this.previews.get(session.sessionId)?.values() ?? [])]
      : [];
  }
  private working = new Map<string, WorkingStatus>();
  workingMessage(session: Session) {
    return this.isConnected(session)
      ? this.working.get(session.sessionId)?.message(!session.idle)
      : undefined;
  }
  sockets = new Map<string, net.Socket>();
  connections = new Set<net.Socket>();
  lastSeen = new Map<string, number>();
  activeSessions = new Map<string, string>();
  allowRegistration = true;
  pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  server: net.Server;
  secret: string;
  onAdmin: (action: string, data: Record<string, unknown>) => Promise<unknown> =
    async () => {
      throw new Error("unsupported");
    };
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly emit: (event: StreamEvent) => void,
  ) {
    const key = path.join(config.dataDir, "ipc.key");
    if (!fs.existsSync(key))
      fs.writeFileSync(key, token(), { mode: 0o600, flag: "wx" });
    this.secret = fs.readFileSync(key, "utf8").trim();
    for (const session of store.sessions()) {
      session.state = "interrupted";
      store.save(session);
    }
    store.db
      .prepare(
        "UPDATE commands SET status='delivery_unknown' WHERE status IN ('forwarded','accepted_by_owner')",
      )
      .run();
    this.server = net.createServer((socket) => this.connect(socket));
  }
  async listen() {
    const file = path.join(this.config.dataDir, "broker.sock");
    if (fs.existsSync(file)) {
      const live = await new Promise<boolean>((resolve) => {
        const probe = net.connect(file);
        probe.once("connect", () => {
          probe.destroy();
          resolve(true);
        });
        probe.once("error", () => resolve(false));
      });
      if (live) throw new Error("Broker already running");
      fs.unlinkSync(file);
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(file, () => {
        fs.chmodSync(file, 0o600);
        resolve();
      });
    });
  }
  private connect(socket: net.Socket) {
    this.connections.add(socket);
    let buffer = "";
    let authenticated = false;
    let instance = "";
    let current = "";
    socket.setEncoding("utf8");
    socket.setTimeout(45000, () => socket.destroy());
    const send = (data: unknown) => {
      if (!socket.destroyed) socket.write(JSON.stringify(data) + "\n");
    };
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 20 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void (async () => {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (!authenticated) {
            const secret = String(value.secret ?? "");
            if (
              secret.length !== this.secret.length ||
              !timingSafeEqual(Buffer.from(secret), Buffer.from(this.secret))
            )
              throw new Error("unauthorized");
            authenticated = true;
            send({ type: "ready" });
            return;
          }
          if (value.type === "admin") {
            try {
              send({
                type: "reply",
                id: value.id,
                data: await this.onAdmin(
                  String(value.action),
                  (value.data as Record<string, unknown>) ?? {},
                ),
              });
            } catch (e) {
              send({
                type: "reply",
                id: value.id,
                error: e instanceof Error ? e.message : "failed",
              });
            }
            return;
          }
          if (value.type === "register") {
            if (!this.allowRegistration) throw new Error("proof_mode");
            const registration = Registration.parse(value.data);
            const directory = registeredWorkingDirectory(this.config, registration.cwd);
            if (!directory) throw new Error("pilot_directory_scope");
            registration.cwd = directory.cwd;
            if (!inDeploymentScope(this.config, registration))
              throw new Error("pilot_history_scope");
            registration.sessionFile = canonicalPath(registration.sessionFile);
            instance = registration.instanceId;
            const publicId = sessionReference(
              registration.sessionFile,
              registration.sessionId,
            );
            const old = this.store.session(publicId);
            const epoch = old
              ? old.instanceId === instance && old.state !== "stopped"
                ? old.epoch
                : old.epoch + 1
              : 1;
            const session: Session = {
              ...registration,
              ...directory,
              sessionId: publicId,
              nativeSessionId:
                publicId === registration.sessionId
                  ? undefined
                  : registration.sessionId,
              epoch,
              sequence: old?.sequence ?? 0,
              prompt:
                registration.prompt ??
                (old?.prompt?.state === "expired" ? old.prompt : undefined),
              state:
                old?.prompt?.state === "expired" && !registration.prompt
                  ? "answer_needed"
                  : registration.prompt
                    ? "waiting"
                    : registration.idle
                      ? "idle"
                      : "running",
              lastActivity: old?.lastActivity ?? Date.now(),
            };
            const existing = this.sockets.get(instance);
            if (existing && existing !== socket) existing.destroy();
            if (current && current !== publicId) this.working.delete(current);
            if (!this.working.has(publicId) || old?.instanceId !== instance)
              this.working.set(publicId, new WorkingStatus());
            if (old?.instanceId !== instance) this.previews.delete(publicId);
            this.store.save(session);
            current = publicId;
            this.activeSessions.set(instance, current);
            this.sockets.set(instance, socket);
            this.lastSeen.set(instance, Date.now());
            send({ type: "registered", epoch });
            this.emit({ version: 1, type: "sessions.changed", data: session });
            return;
          }
          if (!instance) throw new Error("registration_required");
          this.lastSeen.set(instance, Date.now());
          const session = current ? this.store.session(current) : undefined;
          if (
            !session ||
            this.sockets.get(instance) !== socket ||
            session.instanceId !== instance ||
            this.activeSessions.get(instance) !== session.sessionId
          )
            return;
          if (value.type === "heartbeat") {
            const state = value.data as {
              idle: boolean;
              loop: boolean;
              prompt?: Session["prompt"];
            };
            const before = JSON.stringify([
              session.state,
              session.loop,
              session.prompt,
            ]);
            session.idle = state.idle;
            if (state.idle) this.previews.delete(session.sessionId);
            if (state.idle)
              this.working.get(session.sessionId)?.update("agent_settled", null);
            session.loop = state.loop;
            session.prompt =
              state.prompt ??
              (session.prompt?.state === "expired" ? session.prompt : undefined);
            session.state =
              session.prompt?.state === "expired"
                ? "answer_needed"
                : session.prompt
                  ? "waiting"
                  : state.idle
                    ? "idle"
                    : "running";
            this.store.save(session);
            if (
              before !== JSON.stringify([session.state, session.loop, session.prompt])
            )
              this.emit({ version: 1, type: "sessions.changed", data: session });
            return;
          }
          if (value.type === "unregister" || value.type === "private") {
            // Saved-history tombstones retain epoch and cursor across owner changes.
            this.working.delete(session.sessionId);
            this.previews.delete(session.sessionId);
            session.state = "stopped";
            session.prompt = undefined;
            this.store.save(session);
            this.sockets.delete(instance);
            this.activeSessions.delete(instance);
            current = "";
            this.emit({ version: 1, type: "sessions.changed", data: session });
            return;
          }
          if (value.type === "ack") {
            const id = String(value.commandId);
            const row = this.store.command(id);
            if (row?.session !== session.sessionId) return;
            const status = String(value.status);
            if (
              [
                "accepted_by_owner",
                "persisted",
                "rejected",
                "delivery_unknown",
              ].includes(status)
            ) {
              this.store.status(
                id,
                status as "persisted",
                typeof value.error === "string" ? value.error : undefined,
              );
              this.emit({
                version: 1,
                type: "command.status",
                sessionId: session.sessionId,
                data: this.store.command(id),
              });
            }
            return;
          }
          if (value.type === "event") {
            const kind = String(value.kind);
            if (
              ![
                "working_override",
                "tool_progress",
                "message_update",
                "message_end",
                "tool_execution_start",
                "tool_execution_end",
                "agent_start",
                "agent_settled",
                "session_info_changed",
                "prompt",
                "prompt.expired",
                "snapshot",
                "resnapshot",
              ].includes(kind)
            )
              return;
            if (kind === "tool_progress") {
              const data = value.data as ToolProgress;
              if (
                typeof data?.toolCallId !== "string" ||
                data.toolCallId.length > 256 ||
                typeof data.toolDisplay !== "string" ||
                data.toolDisplay.length > 16384 ||
                !Array.isArray(data.toolDisplayStyles) ||
                data.toolDisplayStyles.length > 16385 ||
                data.toolDisplayStyles.some(
                  (style) => !["plain", "command", "added", "removed"].includes(style),
                )
              )
                return;
              let previews = this.previews.get(session.sessionId);
              if (!previews)
                this.previews.set(session.sessionId, (previews = new Map()));
              previews.delete(data.toolCallId);
              const preview = {
                toolCallId: data.toolCallId,
                toolDisplay: data.toolDisplay,
                toolDisplayStyles: [...data.toolDisplayStyles],
              };
              value.data = preview;
              previews.set(data.toolCallId, preview);
              while (previews.size > 16) previews.delete(previews.keys().next().value!);
            }
            if (["agent_start", "agent_settled"].includes(kind))
              this.previews.delete(session.sessionId);
            if (kind === "tool_execution_end")
              this.previews
                .get(session.sessionId)
                ?.delete((value.data as { toolCallId: string }).toolCallId);

            if (kind === "agent_start") this.failures.delete(session.sessionId);
            if (kind === "message_end" || kind === "snapshot") {
              const messages =
                kind === "snapshot"
                  ? Array.isArray(value.data)
                    ? value.data
                    : []
                  : [value.data];
              for (let at = messages.length - 1; at >= 0; at--) {
                const message = messages[at] as { role?: string; stopReason?: string };
                if (message?.role === "assistant") {
                  this.failures.set(
                    session.sessionId,
                    message.stopReason === "error" || message.stopReason === "aborted",
                  );
                  break;
                }
              }
            }
            if (kind === "agent_settled")
              value.data = {
                outcome: this.failures.get(session.sessionId) ? "failed" : "finished",
              };
            const before = JSON.stringify([session.state, session.prompt]);
            const status = this.working.get(session.sessionId)!;
            const previousMessage = status.message(!session.idle);
            status.update(kind, value.data);
            if (kind === "agent_start") {
              session.idle = false;
              session.state = "running";
              if (session.prompt?.state === "expired") session.prompt = undefined;
            }
            if (kind === "agent_settled") {
              session.idle = true;
              session.state =
                session.prompt?.state === "expired"
                  ? "answer_needed"
                  : session.prompt?.state === "pending"
                    ? "waiting"
                    : "idle";
            }
            if (kind === "prompt") {
              const prompt = value.data as Session["prompt"];
              session.prompt = prompt?.state === "resolved" ? undefined : prompt;
              session.state =
                prompt?.state === "expired"
                  ? "answer_needed"
                  : prompt?.state === "pending"
                    ? "waiting"
                    : session.idle
                      ? "idle"
                      : "running";
            }
            if (kind === "prompt.expired") {
              if (session.prompt) session.prompt.state = "expired";
              session.state = "answer_needed";
            }
            if (kind !== "snapshot") session.lastActivity = Date.now();
            if (kind === "session_info_changed")
              session.name = String(
                (value.data as { name?: string })?.name ?? session.name,
              );
            this.store.save(session);
            if (before !== JSON.stringify([session.state, session.prompt]))
              this.emit({ version: 1, type: "sessions.changed", data: session });
            const message = status.message(!session.idle);
            if (message !== previousMessage) {
              const changed = this.store.event(session.sessionId, "working_status", {
                message: message ?? null,
              });
              if (changed) this.emit(changed);
            }
            const event = this.store.event(session.sessionId, kind, value.data);
            if (event) this.emit(event);
          }
        })().catch(() => socket.destroy());
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.connections.delete(socket);
      if (instance && this.sockets.get(instance) === socket) {
        this.working.delete(current);
        this.previews.delete(current);
        this.sockets.delete(instance);
        this.activeSessions.delete(instance);
        for (const session of this.store
          .sessions()
          .filter((s) => s.sessionId === current)) {
          session.state = "disconnected";
          this.store.save(session);
          this.emit({ version: 1, type: "sessions.changed", data: session });
          this.store.db
            .prepare(
              "UPDATE commands SET status='delivery_unknown' WHERE session=? AND status IN ('forwarded','accepted_by_owner')",
            )
            .run(session.sessionId);
        }
      }
    });
  }
  isConnected(session: Session) {
    return (
      this.activeSessions.get(session.instanceId) === session.sessionId &&
      this.sockets.has(session.instanceId)
    );
  }
  send(session: Session, envelope: Envelope, images: unknown[] = []) {
    const socket = this.sockets.get(session.instanceId);
    if (
      !socket ||
      !this.isConnected(session) ||
      Date.now() - (this.lastSeen.get(session.instanceId) ?? 0) > 35000
    )
      throw new Error("owner_unreachable");
    if (session.nativeSessionId && session.nativeSessionEnvelope !== 1)
      throw new Error("native_session_reload_required");
    const nativeEnvelope = session.nativeSessionId
      ? { ...envelope, sessionId: session.nativeSessionId }
      : envelope;
    const line =
      JSON.stringify({ type: "command", envelope: nativeEnvelope, images }) + "\n";
    if (Buffer.byteLength(line) > 16 * 1024 * 1024)
      throw new Error("image_payload_too_large");
    this.store.status(envelope.commandId, "forwarded");
    socket.write(line);
  }
  async close() {
    const closed = [...this.connections].map(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.once("close", resolve);
          socket.destroy();
        }),
    );
    await Promise.all(closed);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export function localRequest(
  config: Config,
  action: string,
  data: Record<string, unknown> = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path.join(config.dataDir, "broker.sock"));
    let buffer = "";
    const id = randomUUID();
    socket.setEncoding("utf8");
    socket.setTimeout(15000, () => {
      socket.destroy();
      reject(new Error("Broker request timed out"));
    });
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({
          secret: fs.readFileSync(path.join(config.dataDir, "ipc.key"), "utf8").trim(),
        }) + "\n",
      ),
    );
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const value = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (value.type === "ready")
          socket.write(JSON.stringify({ type: "admin", id, action, data }) + "\n");
        if (value.type === "reply" && value.id === id) {
          socket.end();
          if (value.error) reject(new Error(value.error));
          else resolve(value.data);
        }
      }
    });
  });
}
