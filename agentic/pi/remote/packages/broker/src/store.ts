import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import type { CommandStatus, Envelope, Session } from "../../protocol/src/index.ts";
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export interface Device {
  id: string;
  name: string;
  credential: string;
  revoked: number;
  created: number;
}
export interface AuthSession {
  hash: string;
  device: string;
  csrf: string;
  verified: number;
  seen: number;
  background: number | null;
  expires: number;
  unlocked: number;
}
export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "broker.sqlite");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT,credential TEXT,revoked INTEGER DEFAULT 0,created INTEGER);
   CREATE TABLE IF NOT EXISTS auth(hash TEXT PRIMARY KEY,device TEXT,csrf TEXT,verified INTEGER,seen INTEGER,background INTEGER,expires INTEGER,unlocked INTEGER DEFAULT 0);
   CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,purpose TEXT,device TEXT,challenge TEXT,expires INTEGER);
   CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT);
   CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,session TEXT,device TEXT,fingerprint TEXT,status TEXT,error TEXT,updated INTEGER);
   CREATE TABLE IF NOT EXISTS events(session TEXT,sequence INTEGER,type TEXT,data TEXT,PRIMARY KEY(session,sequence));
   CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,session TEXT,device TEXT,file TEXT,mime TEXT,hash TEXT,size INTEGER,created INTEGER,referenced INTEGER DEFAULT 0);
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
   CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,time INTEGER,device TEXT,session TEXT,action TEXT,result TEXT);
   PRAGMA user_version=1;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  setting(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value;
  }
  set(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  session(id: string): Session | undefined {
    const row = this.db.prepare("SELECT data FROM sessions WHERE id=?").get(id) as
      { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  sessions(): Session[] {
    return this.db
      .prepare("SELECT data FROM sessions")
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  save(session: Session) {
    this.db
      .prepare(
        "INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(session.sessionId, JSON.stringify(session));
  }
  event(sessionId: string, type: string, data: unknown) {
    return this.transaction(() => {
      const session = this.session(sessionId);
      if (!session) return undefined;
      session.sequence++;
      this.save(session);
      this.db
        .prepare("INSERT INTO events VALUES (?,?,?,?)")
        .run(sessionId, session.sequence, type, JSON.stringify(data));
      this.db
        .prepare("DELETE FROM events WHERE session=? AND sequence<?")
        .run(sessionId, Math.max(0, session.sequence - 1000));
      return { version: 1 as const, type, sessionId, sequence: session.sequence, data };
    });
  }
  journal(envelope: Envelope, device: string) {
    const hash = digest(JSON.stringify(envelope));
    return this.transaction(() => {
      const existing = this.command(envelope.commandId);
      if (existing) {
        if (existing.fingerprint !== hash || existing.device !== device)
          throw new Error("command_id_conflict");
        return existing;
      }
      this.db
        .prepare("INSERT INTO commands VALUES (?,?,?,?,?,?,?)")
        .run(
          envelope.commandId,
          envelope.sessionId,
          device,
          hash,
          "received",
          null,
          Date.now(),
        );
      return this.command(envelope.commandId)!;
    });
  }
  command(id: string) {
    return this.db.prepare("SELECT * FROM commands WHERE id=?").get(id) as
      | {
          id: string;
          session: string;
          device: string;
          fingerprint: string;
          status: CommandStatus;
          error: string | null;
          updated: number;
        }
      | undefined;
  }
  status(id: string, status: CommandStatus, error?: string) {
    this.db
      .prepare(
        "UPDATE commands SET status=?,error=?,updated=? WHERE id=? AND status!='persisted'",
      )
      .run(status, error ?? null, Date.now(), id);
  }
  audit(device: string, session: string, action: string, result: string) {
    this.db
      .prepare(
        "INSERT INTO audit(time,device,session,action,result) VALUES (?,?,?,?,?)",
      )
      .run(Date.now(), device, session, action, result);
  }
  challenge(
    purpose: string,
    challenge: string,
    device = "",
    id: string = randomUUID(),
    ttl = 120000,
  ) {
    this.db.prepare("DELETE FROM challenges WHERE expires<?").run(Date.now());
    this.db
      .prepare("INSERT INTO challenges VALUES (?,?,?,?,?)")
      .run(id, purpose, device, challenge, Date.now() + ttl);
    return id;
  }
  take(id: string, purpose: string) {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM challenges WHERE id=? AND purpose=? AND expires>?")
        .get(id, purpose, Date.now()) as
        | {
            id: string;
            purpose: string;
            device: string;
            challenge: string;
            expires: number;
          }
        | undefined;
      this.db
        .prepare("DELETE FROM challenges WHERE id=? AND purpose=?")
        .run(id, purpose);
      return row;
    });
  }
  device(id: string) {
    return this.db
      .prepare("SELECT * FROM devices WHERE id=? AND revoked=0")
      .get(id) as unknown as Device | undefined;
  }
  close() {
    this.db.close();
  }
}
