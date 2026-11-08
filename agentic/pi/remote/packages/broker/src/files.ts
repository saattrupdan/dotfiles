import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { randomUUID, createHash } from "node:crypto";
import { RemoteError } from "../../protocol/src/index.ts";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
export function homeDirectory(input: string, home: string) {
  const root = fs.realpathSync(home);
  const target = fs.realpathSync(path.resolve(input));
  const rel = path.relative(root, target);
  if (
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel) ||
    !fs.statSync(target).isDirectory()
  )
    throw new RemoteError("invalid_directory");
  fs.accessSync(target, fs.constants.R_OK | fs.constants.X_OK);
  return target;
}
export function browse(input: string, home: string) {
  const dir = homeDirectory(input, home);
  return {
    path: dir,
    parent: dir === fs.realpathSync(home) ? null : path.dirname(dir),
    directories: fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .flatMap((e) => {
        try {
          const target = homeDirectory(path.join(dir, e.name), home);
          return [{ name: e.name, path: target }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 1000),
  };
}
export async function uploadImage(
  bytes: Buffer,
  session: string,
  device: string,
  config: Config,
  store: Store,
) {
  if (bytes.length > config.uploadBytes) throw new RemoteError("image_too_large", 413);
  const used = Number(
    (
      store.db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM uploads").get() as {
        bytes: number;
      }
    ).bytes,
  );
  if (used + bytes.length > config.uploadQuotaBytes)
    throw new RemoteError("upload_quota", 413);
  let data: Buffer;
  try {
    const image = sharp(bytes, { limitInputPixels: 40000000, animated: false });
    const metadata = await image.metadata();
    if (!["jpeg", "png", "webp", "heif"].includes(metadata.format ?? ""))
      throw new Error("format");
    data = await image.rotate().png().toBuffer();
  } catch {
    throw new RemoteError("unsupported_image");
  }
  if (data.length > config.uploadBytes || used + data.length > config.uploadQuotaBytes)
    throw new RemoteError("image_too_large", 413);
  const id = randomUUID();
  const file = path.join(config.dataDir, "attachments", `${id}.png`);
  fs.writeFileSync(file, data, { mode: 0o600, flag: "wx" });
  try {
    store.db
      .prepare("INSERT INTO uploads VALUES (?,?,?,?,?,?,?,?,0)")
      .run(
        id,
        session,
        device,
        file,
        "image/png",
        createHash("sha256").update(data).digest("hex"),
        data.length,
        Date.now(),
      );
  } catch (e) {
    fs.rmSync(file);
    throw e;
  }
  return { id, mime: "image/png", size: data.length };
}
export function imageBlocks(
  ids: string[],
  session: string,
  device: string,
  store: Store,
) {
  return ids.map((id) => {
    const row = store.db
      .prepare("SELECT file,mime FROM uploads WHERE id=? AND session=? AND device=?")
      .get(id, session, device) as { file: string; mime: string } | undefined;
    if (!row) throw new RemoteError("invalid_attachment");
    return {
      type: "image" as const,
      data: fs.readFileSync(row.file).toString("base64"),
      mimeType: row.mime,
    };
  });
}
