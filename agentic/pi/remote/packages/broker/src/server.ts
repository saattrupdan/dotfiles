import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
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
} from "../../protocol/src/index.ts";
import { Store, token, digest } from "./store.ts";
import { Auth, PAIRING_LINK_TTL_MS } from "./auth.ts";
import { Owners } from "./ipc.ts";
import { History } from "./history.ts";
import { Processes } from "./processes.ts";
import { browse, imageBlocks, uploadImage } from "./files.ts";
import { prepare, type Config } from "./config.ts";
import { inDeploymentScope } from "./deployment-scope.ts";
import { inspect } from "../../../../extensions/_session_ownership/ownership.mjs";

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
  const clients = new Map<
    WebSocket,
    {
      device: string;
      request: Parameters<Auth["unlocked"]>[0];
      subscriptions: Set<string>;
    }
  >();
  const emit = (event: StreamEvent) => {
    for (const [socket, client] of clients) {
      try {
        auth.unlocked(client.request);
      } catch {
        socket.close(4001, "locked");
        continue;
      }
      if (
        event.sessionId &&
        !client.subscriptions.has(event.sessionId) &&
        !event.type.startsWith("sessions.") &&
        event.type !== "session.hidden"
      )
        continue;
      if (socket.bufferedAmount > 1024 * 1024) {
        socket.close(4002, "resnapshot_required");
        continue;
      }
      socket.send(JSON.stringify(event));
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
  const owners = new Owners(config, store, emit);
  const catalog = history && !proof ? new History(config) : undefined;
  owners.allowRegistration = !proof;
  const processes = new Processes(config, owners);
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
  const find = async (id: string) => {
    const live = store.session(id);
    if (live && inDeploymentScope(config, live))
      return { id: live.sessionId, path: live.sessionFile, cwd: live.cwd };
    if (config.deploymentPolicy === "pilot")
      throw new RemoteError("session_not_found", 404);
    const native = await catalog?.byId(id);
    if (!native) throw new RemoteError("session_not_found", 404);
    return { id: native.id, path: native.path, cwd: native.cwd };
  };
  const send = (envelope: Envelope, device: string, local = false) => {
    const session = store.session(envelope.sessionId);
    if (!session || !inDeploymentScope(config, session))
      throw new RemoteError("not_owner", 409);
    if (session.epoch !== envelope.epoch) throw new RemoteError("stale_epoch", 409);
    if (envelope.command.action === "handoff" && !local)
      throw new RemoteError("local_only", 403);
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
      owners.send(session, envelope, images);
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
  owners.onAdmin = async (action, data) => {
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
    if (action === "handoff") {
      const id = z.string().uuid().parse(data.sessionId);
      const session = store.session(id);
      if (!session || session.instanceId !== data.expectedOwner)
        throw new Error("Owner unavailable or changed");
      return send(
        {
          version: 1,
          commandId: randomUUID(),
          sessionId: id,
          epoch: session.epoch,
          command: { action: "handoff" },
        },
        "local-admin",
        true,
      );
    }
    throw new Error("Unsupported local action");
  };
  app.get("/api/v1/sessions", async (req) => {
    read(req);
    const native =
      config.deploymentPolicy === "pilot" ? [] : ((await catalog?.catalog()) ?? []);
    const live = store
      .sessions()
      .filter((session) => inDeploymentScope(config, session));
    return [
      ...live,
      ...native
        .filter((n) => !live.some((s) => s.sessionId === n.id))
        .map((n) => ({
          sessionId: n.id,
          name: n.name || n.firstMessage.slice(0, 100) || n.id,
          cwd: n.cwd,
          state: "stopped",
          lastActivity: +n.modified,
          sequence: 0,
          epoch: 0,
        })),
    ].sort((a, b) => b.lastActivity - a.lastActivity);
  });
  app.get("/api/v1/sessions/:id", async (req) => {
    read(req);
    const id = sessionId(req);
    const live = store.session(id);
    return live && inDeploymentScope(config, live) ? live : await find(id);
  });
  app.get("/api/v1/sessions/:id/history", async (req) => {
    read(req);
    const session = await find(sessionId(req));
    const q = z
      .object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query);
    return (
      (await catalog?.messages(session.path, q.offset, q.limit)) ?? {
        messages: [],
        next: null,
      }
    );
  });
  app.post("/api/v1/sessions", async (req) => {
    const a = mutate(req);
    const b = CreateSession.parse(req.body);
    if (proof) throw new RemoteError("proof_mode", 403);
    const session = await processes.launch(b.cwd);
    store.audit(a.device, session.sessionId, "create", "created");
    return session;
  });
  app.post("/api/v1/sessions/:id/recover", async (req) => {
    const a = mutate(req);
    if (proof) throw new RemoteError("proof_mode", 403);
    const native = await find(sessionId(req));
    if (inspect(native.path, path.join(config.dataDir, "ownership")))
      throw new RemoteError("owner_still_alive", 409);
    const session = await processes.launch(native.cwd, native);
    store.audit(a.device, session.sessionId, "recover", "recovered");
    return session;
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
    return browse(input.path ?? config.home, config.home);
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
    for (const row of store.db
      .prepare("SELECT key,value FROM settings WHERE key LIKE 'push:%'")
      .all()) {
      const device = (row.key as string).split(":")[1]!;
      if (!store.device(device)) continue;
      if (
        [...clients.values()].some(
          (c) => c.device === device && c.subscriptions.has(event.sessionId ?? ""),
        )
      )
        continue;
      try {
        await webpush.sendNotification(
          JSON.parse(row.value as string),
          JSON.stringify({
            title: "Pi Remote",
            body:
              event.type === "agent_settled"
                ? "A run finished."
                : "Pi needs your attention.",
            url: `/session/${event.sessionId}`,
          }),
          { TTL: 3600, timeout: 10000 },
        );
      } catch {
        /* Expired endpoints are reported by doctor without conversation data. */
      }
    }
  }
  app.get("/api/v1/status", async (req) => {
    read(req);
    return { online: true, owners: owners.sockets.size, version: 1 };
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
      };
      clients.set(socket, client);
      socket.on("message", (raw) => {
        try {
          read(req);
          const b = z
            .object({
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
          client.subscriptions = new Set(b.subscriptions.map((s) => s.sessionId));
          for (const sub of b.subscriptions) {
            const session = store.session(sub.sessionId);
            if (!session || !inDeploymentScope(config, session)) continue;
            const rows = store.db
              .prepare(
                "SELECT sequence,type,data FROM events WHERE session=? AND sequence>? ORDER BY sequence",
              )
              .all(sub.sessionId, sub.sequence);
            if (rows.length && Number(rows[0]!.sequence) === sub.sequence + 1) {
              for (const row of rows)
                socket.send(
                  JSON.stringify({
                    version: 1,
                    type: row.type,
                    sessionId: sub.sessionId,
                    sequence: row.sequence,
                    data: JSON.parse(row.data as string),
                  }),
                );
            } else
              socket.send(
                JSON.stringify({
                  version: 1,
                  type: "resnapshot",
                  sessionId: sub.sessionId,
                  sequence: session.sequence,
                  data: session,
                }),
              );
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
            true,
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
  if (ipc) await owners.listen();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    for (const socket of clients.keys()) socket.close(1001, "broker_restart");
    if (ipc) await owners.close();
    store.close();
  });
  return { app, store, owners, auth, config };
}
