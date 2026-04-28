import { randomUUID } from "node:crypto";

export function shortId(): string {
  return randomUUID().slice(0, 8);
}
