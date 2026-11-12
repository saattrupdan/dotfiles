import { ToolDisplay } from "./tool-display.ts";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import webpush from "web-push";
import { z, ZodError } from "zod";
import type { WebSocket } from "ws";
import {
  Envelope,
  CreateSession,
  RemoteError,
  type StreamEvent,
  type Session,
  type SessionFolder,
} from "../../protocol/src/index.ts";
import { Store, token, digest } from "./store.ts";
import { Auth, PAIRING_LINK_TTL_MS } from "./auth.ts";
import { Connections } from "./ipc.ts";
import { History, RECENT_SESSION_MS } from "./history.ts";
import { Processes } from "./processes.ts";
import { browse, imageBlocks, uploadImage } from "./files.ts";
import { prepare, type Config } from "./config.ts";
import {
  inDeploymentScope,
  visibleWorkingDirectory,
  canonicalPath,
} from "./deployment-scope.ts";

export async function createBroker(
  config: Config,
  {
    ipc = true,
    history = true,
    proof = false,
  }: { ipc?: boolean; history?: boolean; proof?: boolean } = {},
) {
  prepare(config);
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, requestTimeout: 60000 });
  const store = new Store(config.dataDir);
  type Client = {
    device: string;
    request: Parameters<Auth["unlocked"]>[0];
    subscriptions: Set<string>;
    minimumLiveSequence: Map<string, number>;
    subscriptionGeneration: number;
    windowed: boolean;
  };
  const clients = new Map<WebSocket, Client>();
  const display = new ToolDisplay(config.agentDir);
  const emit = (event: StreamEvent) => {
    const session = event.sessionId ? store.session(event.sessionId) : undefined;
    if (
      event.sessionId &&
      !event.type.startsWith("sessions.") &&
      event.type !== "session.hidden" &&
      (!session || !inDeploymentScope(config, session) || !recent(session))
    )
      return;
    const windowed =
      event.type === "snapshot" &&
      ![...clients.values()].some(
        (client) => !client.windowed && client.subscriptions.has(event.sessionId ?? ""),
      );
    display.emit(
      windowed ? { ...event, type: "resnapshot", data: null } : event,
      session?.runtimeCwd ?? session?.cwd ?? "/",
      publish,
      session?.sessionFile ?? "",
    );
  };
  function deliver(socket: WebSocket, client: Client, event: StreamEvent) {
    if (event.type.startsWith("sessions.")) event = { ...event, data: null };
    else if (event.sessionId && event.type !== "session.hidden") {
      const session = store.session(event.sessionId);
      if (!session || !inDeploymentScope(config, session) || !recent(session)) return;
    }
    if (
      event.sessionId &&
      !client.subscriptions.has(event.sessionId) &&
      !event.type.startsWith("sessions.") &&
      event.type !== "session.hidden"
    )
      return;
    try {
      auth.unlocked(client.request);
    } catch {
      socket.close(4001, "locked");
      return;
    }
    if (socket.bufferedAmount > 1024 * 1024) {
      socket.close(4002, "resnapshot_required");
      return;
    }
    if (client.windowed && event.type === "snapshot")
      event = { ...event, type: "resnapshot", data: null };
    socket.send(JSON.stringify(event));
  }
  const publish = (event: StreamEvent) => {
    for (const [socket, client] of clients) {
      if (
        event.sessionId &&
        !event.type.startsWith("sessions.") &&
        event.type !== "session.hidden" &&
        (event.sequence ?? Infinity) <=
          (client.minimumLiveSequence.get(event.sessionId) ?? -1)
      )
        continue;
      deliver(socket, client, event);
    }
    if (
      event.type === "agent_settled" ||
      event.type === "prompt" ||
      event.type === "prompt.expired"
    )
      void notify(event);
  };
  const auth = new Auth(store, config, (device, suspended = false) => {
    for (const [socket, client] of clients)
      if (client.device === device)
        socket.close(
          suspended ? 4000 : 4001,
          suspended ? "background" : "locked_or_revoked",
        );
  });
  const connections = new Connections(config, store, emit);
  const catalog = history && !proof ? new History(config, display) : undefined;
  connections.allowRegistration = !proof;
  const processes = new Processes(config, connections);
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: config.uploadBytes, files: 1, fields: 1, parts: 2 },
  });
  await app.register(websocket, { options: { maxPayload: 65536 } });
  const limits = new Map<string, { at: number; count: number }>();
  app.addHook("onRequest", async (req, reply) => {
    reply.header(
      "Cache-Control",
      req.url.startsWith("/api/") ? "no-store" : "no-cache",
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (req.headers.host !== new URL(config.origin).host)
      throw new RemoteError("invalid_host", 403);
    if (req.headers.origin && req.headers.origin !== config.origin)
      throw new RemoteError("invalid_origin", 403);
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.headers.origin !== config.origin
    )
      throw new RemoteError("origin_required", 403);
    const key = `${req.ip}:${/auth|pairing/.test(req.url) ? "auth" : "other"}`;
    const now = Date.now();
    let bucket = limits.get(key);
    if (!bucket || now - bucket.at > 60000) {
      bucket = { at: now, count: 0 };
      limits.set(key, bucket);
    }
    if (++bucket.count > (key.endsWith("auth") ? 30 : 600))
      throw new RemoteError("rate_limited", 429);
    if (limits.size > 10000)
      for (const [k, v] of limits) if (now - v.at > 60000) limits.delete(k);
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({ error: "invalid_input" });
    if (error instanceof RemoteError)
      return reply.code(error.statusCode).send({ error: error.code });
    const status = (error as { statusCode?: number }).statusCode;
    return reply
      .code(status && status < 500 ? status : 500)
      .send({ error: status && status < 500 ? "invalid_request" : "internal_error" });
  });
  auth.routes(app);
  const read = (req: Parameters<Auth["unlocked"]>[0]) => auth.unlocked(req);
  const mutate = (req: Parameters<Auth["unlocked"]>[0]) => {
    const a = read(req);
    auth.csrf(req, a);
    return a;
  };
  const sessionId = (req: { params: unknown }) =>
    z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
  const discoverLaptop =
    config.deploymentPolicy !== "pilot" || config.pilotScope === "laptop-main";
  const lastActivity = (session: Session) => {
    let modified = 0;
    try {
      modified = fs.statSync(session.sessionFile).mtimeMs;
    } catch {
      /* Unflushed native path. */
    }
    return Math.max(session.lastActivity, modified);
  };
  const recent = (session: Session) =>
    lastActivity(session) >= Date.now() - RECENT_SESSION_MS;
  const visibleLive = () =>
    store
      .sessions()
      .filter((session) => inDeploymentScope(config, session) && recent(session));
  const liveSummary = (session: Session) => {
    const connected = connections.isConnected(session);
    return {
      ...session,
      workingMessage: connections.workingMessage(session),
      lastActivity: lastActivity(session),
      state: connected ? session.state : "stopped",
      controlBlockedReason:
        connected && session.nativeSessionId && session.nativeSessionEnvelope !== 1
          ? "Phone control needs /reload in this session on the Mac."
          : undefined,
    };
  };
  const nativeSummary = (n: NonNullable<Awaited<ReturnType<History["byId"]>>>) => ({
    sessionId: n.id,
    name: n.name || "Saved conversation",
    cwd: n.cwd,
    state: "stopped",
    lastActivity: +n.modified,
    sequence: 0,
    epoch: 0,
    recoveryBlockedReason: n.ambiguous ? "ambiguous_session_id" : undefined,
  });
  const find = async (id: string) => {
    const live = store.session(id);
    if (live && inDeploymentScope(config, live) && recent(live)) {
      const named = discoverLaptop ? await catalog?.byId(id) : undefined;
      return {
        ...liveSummary(live),
        name: named?.name || live.name,
        id: live.nativeSessionId ?? live.sessionId,
        path: live.sessionFile,
      };
    }
    if (!discoverLaptop) throw new RemoteError("session_not_found", 404);
    const native = await catalog?.byId(id);
    if (!native) throw new RemoteError("session_not_found", 404);
    return {
      ...nativeSummary(native),
      id: native.nativeId,
      path: native.path,
      ambiguous: native.ambiguous,
    };
  };
  const send = (envelope: Envelope, device: string) => {
    const session = store.session(envelope.sessionId);
    if (!session || !inDeploymentScope(config, session) || !recent(session))
      throw new RemoteError("not_owner", 409);
    if (session.nativeSessionId && session.nativeSessionEnvelope !== 1)
      throw new RemoteError("native_session_reload_required", 409);
    if (session.epoch !== envelope.epoch) throw new RemoteError("stale_epoch", 409);
    const existing = store.command(envelope.commandId);
    let row;
    try {
      row = store.journal(envelope, device);
    } catch {
      throw new RemoteError("command_id_conflict", 409);
    }
    if (existing) return row;
    try {
      const images =
        envelope.command.action === "message"
          ? imageBlocks(envelope.command.images, envelope.sessionId, device, store)
          : [];
      connections.send(session, envelope, images);
    } catch (error) {
      store.status(
        envelope.commandId,
        "rejected",
        error instanceof Error ? error.message : "invalid_input",
      );
    }
    if (envelope.command.action === "message")
      for (const id of envelope.command.images)
        store.db.prepare("UPDATE uploads SET referenced=1 WHERE id=?").run(id);
    store.audit(
      device,
      envelope.sessionId,
      envelope.command.action,
      store.command(envelope.commandId)!.status,
    );
    return store.command(envelope.commandId);
  };
  connections.onAdmin = async (action, data) => {
    if (action === "pair") {
      const secret = token();
      store.challenge("pair", "", "", digest(secret), PAIRING_LINK_TTL_MS);
      return {
        url: `${config.origin}/pair#${secret}`,
        expiresAt: Date.now() + PAIRING_LINK_TTL_MS,
      };
    }
    if (action === "devices")
      return store.db.prepare("SELECT id,name,created,revoked FROM devices").all();
    if (action === "revoke") {
      auth.revoke(z.string().uuid().parse(data.id));
      return { revoked: true };
    }
    if (action === "status")
      return {
        sessions: store
          .sessions()
          .map((s) => ({ id: s.sessionId, state: s.state, managed: s.managed })),
        devices: Number(
          (
            store.db
              .prepare("SELECT count(*) n FROM devices WHERE revoked=0")
              .get() as { n: number }
          ).n,
        ),
      };
    throw new Error("Unsupported local action");
  };
  app.get("/api/v1/session-folders", async (req) => {
    read(req);
    const live = visibleLive();
    const groups = new Map<string, SessionFolder>(
      (discoverLaptop
        ? ((await catalog?.folders(live.map((s) => canonicalPath(s.sessionFile)))) ??
          [])
        : []
      ).map((folder) => [folder.cwd, folder]),
    );
    for (const session of live) {
      const group = groups.get(session.cwd) ?? {
        cwd: session.cwd,
        count: 0,
        lastActivity: 0,
      };
      group.count++;
      group.lastActivity = Math.max(group.lastActivity, lastActivity(session));
      groups.set(session.cwd, group);
    }
    return [...groups.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  });
  app.get("/api/v1/sessions", async (req) => {
    read(req);
    const { folder } = z
      .object({ folder: z.string().max(4096).optional() })
      .parse(req.query);
    const allLive = visibleLive();
    const live = allLive
      .filter((s) => folder === undefined || s.cwd === folder)
      .map(liveSummary);
    // No archive labels or transcripts are read until a folder is selected.
    const native =
      discoverLaptop && folder !== undefined
        ? ((await catalog?.catalog(folder)) ?? [])
        : [];
    return [
      ...live.map((session) => ({
        ...session,
        name:
          native.find(
            (row) =>
              row.nativeId === (session.nativeSessionId ?? session.sessionId) &&
              row.path === canonicalPath(session.sessionFile),
          )?.name || session.name,
      })),
      ...native
        .filter(
          (n) =>
            !allLive.some(
              (s) =>
                (s.nativeSessionId ?? s.sessionId) === n.nativeId &&
                canonicalPath(s.sessionFile) === n.path,
            ),
        )
        .map(nativeSummary),
    ].sort((a, b) => b.lastActivity - a.lastActivity);
  });
  app.get("/api/v1/sessions/:id", async (req) => {
    read(req);
    return find(sessionId(req));
  });
  app.get("/api/v1/sessions/:id/history", async (req) => {
    read(req);
    const session = await find(sessionId(req));
    const q = z
      .object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        window: z.literal("latest").optional(),
        before: z.string().max(64).optional(),
        count: z.coerce.number().int().min(1).max(100000).optional(),
        proof: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        anchor: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      })
      .parse(req.query);
    const result =
      q.window || q.before
        ? ((await catalog?.window(
            session.path,
            session.id,
            "runtimeCwd" in session ? (session.runtimeCwd ?? session.cwd) : session.cwd,
            q,
          )) ?? {
            messages: [],
            older: null,
            revision: "empty",
          })
        : ((await catalog?.messages(session.path, q.offset, q.limit, session.id)) ?? {
            messages: [],
            next: null,
          });
    read(req);
    const current = await find(sessionId(req));
    read(req);
    if (current.path !== session.path || current.id !== session.id)
      throw new RemoteError("session_changed", 409);
    return result;
  });
  app.post("/api/v1/sessions", async (req) => {
    const a = mutate(req);
    const b = CreateSession.parse(req.body);
    if (proof) throw new RemoteError("proof_mode", 403);
    const session = await processes.launch(b.cwd);
    store.audit(a.device, session.sessionId, "create", "created");
    return session;
  });
  const recovering = new Map<string, Promise<Session>>();
  app.post("/api/v1/sessions/:id/recover", async (req) => {
    const a = mutate(req);
    if (proof) throw new RemoteError("proof_mode", 403);
    const id = sessionId(req);
    const active = store.session(id);
    if (active && inDeploymentScope(config, active) && connections.isConnected(active))
      return liveSummary(active);
    const ongoing = recovering.get(id);
    if (ongoing) return ongoing;
    const native = await find(id);
    if ("ambiguous" in native && native.ambiguous)
      throw new RemoteError("ambiguous_session_id", 409);
    const claimed = recovering.get(id);
    if (claimed) return claimed;
    const pending = processes.launch(native.cwd, native);
    recovering.set(id, pending);
    try {
      const session = await pending;
      store.audit(a.device, session.sessionId, "recover", "recovered");
      return session;
    } finally {
      recovering.delete(id);
    }
  });
  for (const route of ["actions", "messages", "stop"]) {
    app.post(`/api/v1/sessions/:id/${route}`, async (req) => {
      const a = mutate(req);
      const envelope = Envelope.parse(req.body);
      if (envelope.sessionId !== sessionId(req)) throw new RemoteError("invalid_input");
      return send(envelope, a.device);
    });
  }
  app.get("/api/v1/commands/:id", async (req) => {
    const a = read(req);
    const row = store.command(sessionId(req));
    if (!row || row.device !== a.device)
      throw new RemoteError("command_not_found", 404);
    return row;
  });
  app.get("/api/v1/directories", async (req) => {
    read(req);
    const input = z.object({ path: z.string().optional() }).parse(req.query);
    const directory = browse(input.path ?? config.home, config.home);
    if (!visibleWorkingDirectory(config, directory.path))
      throw new RemoteError("invalid_directory", 403);
    return {
      ...directory,
      directories: directory.directories.filter((child) =>
        visibleWorkingDirectory(config, child.path),
      ),
    };
  });
  app.get("/api/v1/favorites", async (req) => {
    read(req);
    return JSON.parse(store.setting("favorites") ?? "[]");
  });
  app.put("/api/v1/favorites", async (req) => {
    mutate(req);
    const paths = z
      .array(z.string())
      .max(50)
      .parse(req.body)
      .map((p) => browse(p, config.home).path);
    store.set("favorites", JSON.stringify(paths));
    return paths;
  });
  app.post("/api/v1/uploads", async (req) => {
    const a = mutate(req);
    const id = z
      .string()
      .uuid()
      .parse((req.query as { sessionId?: string }).sessionId);
    await find(id);
    const part = await req.file();
    if (!part) throw new RemoteError("image_required");
    return uploadImage(await part.toBuffer(), id, a.device, config, store);
  });
  app.get("/api/v1/attachments/:id", async (req, reply) => {
    read(req);
    const row = store.db
      .prepare("SELECT file,mime,session FROM uploads WHERE id=?")
      .get(sessionId(req)) as
      { file: string; mime: string; session: string } | undefined;
    if (!row) throw new RemoteError("attachment_not_found", 404);
    if (config.deploymentPolicy === "pilot") await find(row.session);
    return reply
      .header("Content-Disposition", "inline")
      .type(row.mime)
      .send(fs.createReadStream(row.file));
  });
  let vapid = store.setting("vapid");
  if (!vapid) {
    vapid = JSON.stringify(webpush.generateVAPIDKeys());
    store.set("vapid", vapid);
  }
  const keys = JSON.parse(vapid);
  webpush.setVapidDetails(
    `https://${new URL(config.origin).hostname}`,
    keys.publicKey,
    keys.privateKey,
  );
  app.get("/api/v1/push/key", async (req) => {
    read(req);
    return { key: keys.publicKey };
  });
  app.post("/api/v1/push/subscriptions", async (req) => {
    const a = mutate(req);
    const sub = z
      .object({
        endpoint: z.string().url(),
        keys: z.object({ auth: z.string().max(200), p256dh: z.string().max(300) }),
      })
      .parse(req.body);
    const url = new URL(sub.endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      ![
        "web.push.apple.com",
        "fcm.googleapis.com",
        "updates.push.services.mozilla.com",
      ].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    )
      throw new RemoteError("invalid_push_endpoint");
    store.set(`push:${a.device}:${digest(sub.endpoint)}`, JSON.stringify(sub));
    return { subscribed: true };
  });
  app.delete("/api/v1/push/subscriptions", async (req) => {
    const a = mutate(req);
    store.db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`push:${a.device}:%`);
    return { unsubscribed: true };
  });
  async function notify(event: StreamEvent) {
    const title =
      (store.session(event.sessionId ?? "")?.name ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160) || "Pi Remote";
    for (const row of store.db
      .prepare("SELECT key,value FROM settings WHERE key LIKE 'push:%'")
      .all()) {
      const device = (row.key as string).split(":")[1]!;
      if (!store.device(device)) continue;
      if (
        [...clients.values()].some((c) => {
          if (c.device !== device || !c.subscriptions.has(event.sessionId ?? ""))
            return false;
          try {
            auth.unlocked(c.request);
            return true;
          } catch {
            return false;
          }
        })
      )
        continue;
      try {
        await webpush.sendNotification(
          JSON.parse(row.value as string),
          JSON.stringify({
            title,
            body:
              event.type === "agent_settled"
                ? (event.data as { outcome?: string } | null)?.outcome === "failed"
                  ? "A run failed."
                  : "A run finished."
                : "Pi needs your attention.",
            url: `/session/${event.sessionId}`,
          }),
          { TTL: 3600, timeout: 10000 },
        );
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410)
          store.db
            .prepare("DELETE FROM settings WHERE key=? AND value=?")
            .run(row.key, row.value);
        store.audit(
          device,
          event.sessionId ?? "",
          "push",
          status ? `failed_${status}` : "failed",
        );
      }
    }
  }
  app.get("/api/v1/status", async (req) => {
    read(req);
    return { online: true, connections: connections.sockets.size, version: 1 };
  });
  app.get(
    "/api/v1/events",
    {
      websocket: true,
      preValidation: async (req) => {
        read(req);
        if (req.headers.origin !== config.origin)
          throw new RemoteError("invalid_origin", 403);
      },
    },
    (socket, req) => {
      const a = read(req);
      const client = {
        device: a.device,
        request: req,
        subscriptions: new Set<string>(),
        minimumLiveSequence: new Map<string, number>(),
        subscriptionGeneration: 0,
        windowed: false,
      };
      clients.set(socket, client);
      socket.on("message", (raw) => {
        try {
          read(req);
          const b = z
            .object({
              historyWindow: z.boolean().optional(),
              subscriptions: z
                .array(
                  z.object({
                    sessionId: z.string().uuid(),
                    sequence: z.number().int().min(0),
                  }),
                )
                .max(100),
            })
            .parse(JSON.parse(raw.toString()));
          client.windowed = b.historyWindow === true;
          client.subscriptions = new Set<string>();
          client.minimumLiveSequence.clear();
          const round = ++client.subscriptionGeneration;
          for (const sub of b.subscriptions) {
            const session = store.session(sub.sessionId);
            if (!session || !inDeploymentScope(config, session) || !recent(session))
              continue;
            client.subscriptions.add(sub.sessionId);
            // Already-queued live events through this snapshot must not overtake replay.
            client.minimumLiveSequence.set(sub.sessionId, session.sequence);
            const replay = (event: StreamEvent) =>
              display.emit(
                client.windowed && event.type === "snapshot"
                  ? { ...event, type: "resnapshot", data: null }
                  : event,
                session.runtimeCwd ?? session.cwd,
                (formatted) => {
                  if (round !== client.subscriptionGeneration) return;
                  if (formatted.type === "tool_progress_snapshot") {
                    const current = store.session(sub.sessionId);
                    if (
                      !current ||
                      current.instanceId !== session.instanceId ||
                      current.epoch !== session.epoch
                    )
                      return;
                    const progress = connections.progress(current);
                    deliver(socket, client, { ...formatted, data: progress });
                  } else deliver(socket, client, formatted);
                },
                session.sessionFile,
              );
            const rows = store.db
              .prepare(
                "SELECT sequence,type,data FROM events WHERE session=? AND sequence>? ORDER BY sequence",
              )
              .all(sub.sessionId, sub.sequence);
            if (rows.length && Number(rows[0]!.sequence) === sub.sequence + 1) {
              for (const row of rows)
                replay({
                  version: 1,
                  type: String(row.type),
                  sessionId: sub.sessionId,
                  sequence: Number(row.sequence),
                  data: JSON.parse(row.data as string),
                });
            } else
              replay({
                version: 1,
                type: "resnapshot",
                sessionId: sub.sessionId,
                sequence: session.sequence,
                data: session,
              });
            replay({
              version: 1,
              type: "tool_progress_snapshot",
              sessionId: sub.sessionId,
              data: null,
            });
          }
        } catch {
          socket.close(4003, "invalid_subscription");
        }
      });
      socket.on("close", () => clients.delete(socket));
    },
  );
  const webRoot =
    config.webDir ?? fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (fs.existsSync(webRoot)) {
    await app.register(staticFiles, { root: webRoot, prefix: "/" });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "not_found" })
        : reply.sendFile("index.html"),
    );
  }
  const timer = setInterval(() => {
    for (const [socket, client] of clients) {
      try {
        read(client.request);
      } catch {
        socket.close(4001, "locked");
      }
    }
    for (const session of store.sessions())
      if (
        inDeploymentScope(config, session) &&
        session.managed &&
        session.idle &&
        !session.loop &&
        !session.prompt &&
        session.state === "idle" &&
        Date.now() - session.lastActivity > config.idleMs
      ) {
        try {
          send(
            {
              version: 1,
              commandId: randomUUID(),
              sessionId: session.sessionId,
              epoch: session.epoch,
              command: { action: "stop_session" },
            },
            "local-admin",
          );
          session.state = "stopping";
          store.save(session);
        } catch {
          /* Never force-kill an uncertain owner. */
        }
      }
    processes.reapIdleShells();
  }, 5000);
  timer.unref();
  if (ipc) await connections.listen();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    for (const socket of clients.keys()) socket.close(1001, "broker_restart");
    if (ipc) await connections.close();
    store.close();
  });
  return { app, store, connections, auth, config };
}
