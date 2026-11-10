import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import { z } from "zod";
import { DeviceName, RemoteError } from "../../protocol/src/index.ts";
import { Store, digest, token, type AuthSession } from "./store.ts";
import type { Config } from "./config.ts";
export const PAIRING_LINK_TTL_MS = 10 * 60 * 1000;
const COOKIE = "__Host-pi-remote";
const GRACE = 120000;
const LEASE = 45000;
const MAX_VERIFIED = 15 * 60 * 1000;
export class Auth {
  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly revokeStreams: (device: string, suspended?: boolean) => void,
  ) {}
  paired(req: FastifyRequest): AuthSession {
    const raw = req.cookies[COOKIE];
    if (!raw) throw new RemoteError("pairing_required", 401);
    const row = this.store.db
      .prepare("SELECT * FROM auth WHERE hash=? AND expires>?")
      .get(digest(raw), Date.now()) as unknown as AuthSession | undefined;
    if (!row || !this.store.device(row.device))
      throw new RemoteError("pairing_required", 401);
    return row;
  }
  csrf(req: FastifyRequest, row = this.paired(req)) {
    if (req.headers["x-pi-csrf"] !== row.csrf) throw new RemoteError("csrf", 403);
    return row;
  }
  unlocked(req: FastifyRequest) {
    const row = this.paired(req);
    const now = Date.now();
    if (
      !row.unlocked ||
      Date.now() - row.verified > MAX_VERIFIED ||
      row.background !== null ||
      now - row.seen > LEASE
    )
      throw new RemoteError("locked", 423);
    return row;
  }
  issue(reply: FastifyReply, device: string, unlocked = false) {
    const raw = token();
    this.store.db
      .prepare("INSERT INTO auth VALUES (?,?,?,?,?,?,?,?)")
      .run(
        digest(raw),
        device,
        token(),
        unlocked ? Date.now() : 0,
        Date.now(),
        null,
        Date.now() + 30 * 86400000,
        unlocked ? 1 : 0,
      );
    reply.setCookie(COOKIE, raw, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 30 * 86400,
    });
  }
  revoke(device: string) {
    this.store.db.prepare("UPDATE devices SET revoked=1 WHERE id=?").run(device);
    this.store.db.prepare("DELETE FROM auth WHERE device=?").run(device);
    this.store.db
      .prepare("DELETE FROM settings WHERE key LIKE ?")
      .run(`push:${device}:%`);
    this.revokeStreams(device);
    this.store.audit(device, "", "revoke", "revoked");
  }
  routes(app: FastifyInstance) {
    const rpID = new URL(this.config.origin).hostname;
    app.get("/api/v1/me", async (req) => {
      try {
        const a = this.paired(req);
        return {
          paired: true,
          csrf: a.csrf,
          device: this.store.device(a.device)?.name,
        };
      } catch {
        return { paired: false };
      }
    });
    app.post("/api/v1/auth/lock", async (req) => {
      const a = this.csrf(req);
      this.store.db.prepare("UPDATE auth SET unlocked=0 WHERE hash=?").run(a.hash);
      this.revokeStreams(a.device);
      return { locked: true };
    });
    app.post("/api/v1/auth/presence", async (req) => {
      const a = this.csrf(req);
      const body = z.object({ foreground: z.boolean() }).parse(req.body);
      const now = Date.now();
      if (
        !a.unlocked ||
        now - a.verified > MAX_VERIFIED ||
        (a.background === null && now - a.seen > LEASE) ||
        (a.background !== null && now - a.background >= GRACE)
      ) {
        this.store.db.prepare("UPDATE auth SET unlocked=0 WHERE hash=?").run(a.hash);
        throw new RemoteError("locked", 423);
      }
      this.store.db
        .prepare("UPDATE auth SET seen=?,background=? WHERE hash=?")
        .run(now, body.foreground ? null : (a.background ?? now), a.hash);
      if (!body.foreground) this.revokeStreams(a.device, true);
      return { unlocked: true, graceMs: GRACE };
    });
    app.post("/api/v1/pairing/options", async (req) => {
      const b = z
        .object({ token: z.string().min(32).max(100), name: DeviceName })
        .parse(req.body);
      const challenge = this.store.take(digest(b.token), "pair");
      if (!challenge) throw new RemoteError("pairing_expired", 401);
      const id = randomUUID();
      const options = await generateRegistrationOptions({
        rpName: "Pi Remote",
        rpID,
        userName: b.name,
        userID: new TextEncoder().encode(id),
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
          authenticatorAttachment: "platform",
        },
      });
      const ceremony = this.store.challenge(
        "registration",
        options.challenge,
        JSON.stringify({ id, name: b.name }),
      );
      return { ceremony, options };
    });
    app.post("/api/v1/pairing/finish", async (req, reply) => {
      const b = z
        .object({
          ceremony: z.string().uuid(),
          response: z.record(z.string(), z.unknown()),
        })
        .parse(req.body);
      const c = this.store.take(b.ceremony, "registration");
      if (!c) throw new RemoteError("challenge_expired", 401);
      const v = await verifyRegistrationResponse({
        response: b.response as unknown as RegistrationResponseJSON,
        expectedChallenge: c.challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
      if (!v.verified || !v.registrationInfo)
        throw new RemoteError("verification_failed", 401);
      const device = JSON.parse(c.device) as { id: string; name: string };
      const credential = v.registrationInfo.credential;
      this.store.db.prepare("INSERT INTO devices VALUES (?,?,?,0,?)").run(
        device.id,
        device.name,
        JSON.stringify({
          ...credential,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        }),
        Date.now(),
      );
      this.issue(reply, device.id);
      this.store.audit(device.id, "", "pair", "paired");
      return { paired: true };
    });
    app.post("/api/v1/auth/options", async (req) => {
      let device = "";
      try {
        device = this.csrf(req).device;
      } catch {
        /* Discoverable passkey supports opening the installed PWA after Safari pairing. */
      }
      const row = device ? this.store.device(device) : undefined;
      const credential = row ? JSON.parse(row.credential) : undefined;
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: "required",
        allowCredentials: credential ? [{ id: credential.id }] : undefined,
      });
      return {
        ceremony: this.store.challenge("assert", options.challenge, device),
        options,
      };
    });
    app.post("/api/v1/auth/assert", async (req, reply) => {
      const b = z
        .object({
          ceremony: z.string().uuid(),
          response: z.record(z.string(), z.unknown()),
        })
        .parse(req.body);
      const c = this.store.take(b.ceremony, "assert");
      if (!c) throw new RemoteError("challenge_expired", 401);
      const response = b.response as unknown as AuthenticationResponseJSON;
      const row = c.device
        ? this.store.device(c.device)
        : (this.store.db
            .prepare(
              "SELECT * FROM devices WHERE revoked=0 AND json_extract(credential,'$.id')=?",
            )
            .get(response.id) as unknown as ReturnType<Store["device"]>);
      if (!row) throw new RemoteError("verification_failed", 401);
      const saved = JSON.parse(row.credential);
      const credential: WebAuthnCredential = {
        ...saved,
        publicKey: Buffer.from(saved.publicKey, "base64url"),
      };
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: c.challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: rpID,
        credential,
        requireUserVerification: true,
      });
      if (!v.verified) throw new RemoteError("verification_failed", 401);
      this.store.db
        .prepare("UPDATE devices SET credential=? WHERE id=?")
        .run(
          JSON.stringify({ ...saved, counter: v.authenticationInfo.newCounter }),
          row.id,
        );
      let a: AuthSession | undefined;
      try {
        a = this.paired(req);
      } catch {
        /* New installed-PWA cookie jar. */
      }
      if (!a || a.device !== row.id) {
        this.issue(reply, row.id, true);
        return { verified: true };
      }
      this.store.db
        .prepare(
          "UPDATE auth SET unlocked=1,verified=?,seen=?,background=NULL WHERE hash=?",
        )
        .run(Date.now(), Date.now(), a.hash);
      return { verified: true };
    });
    app.get("/api/v1/devices", async (req) => {
      this.unlocked(req);
      return this.store.db
        .prepare("SELECT id,name,created FROM devices WHERE revoked=0")
        .all();
    });
    app.delete("/api/v1/devices/:id", async (req) => {
      this.unlocked(req);
      this.csrf(req);
      this.revoke(
        z
          .string()
          .uuid()
          .parse((req.params as { id: string }).id),
      );
      return { revoked: true };
    });
  }
}
