import { createHash } from "node:crypto";

export function memberThreadDocumentId(uid: string, threadId: string): string {
  return `member_${createHash("sha256")
    .update(`${uid}:${threadId}`)
    .digest("hex")
    .slice(0, 40)}`;
}
