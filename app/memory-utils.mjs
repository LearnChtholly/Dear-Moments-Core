import { randomUUID, createHash } from "node:crypto";
export const stamp = () => new Date().toISOString();
export const uid = () => randomUUID();
export const signature = (s) => createHash("sha256").update(s).digest("hex");
export const parse = (s, fallback = []) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
