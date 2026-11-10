import { createHash } from "node:crypto";
import { Id } from "../../protocol/src/index.ts";
import { canonicalPath } from "./deployment-scope.ts";

/** Public references stay UUIDs; native SDK IDs and session files remain unchanged. */
export function pathReference(file: string): string {
  const bytes = createHash("sha256")
    .update(canonicalPath(file))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x50;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sessionReference(file: string, nativeId: string): string {
  return Id.safeParse(nativeId).success ? nativeId : pathReference(file);
}
