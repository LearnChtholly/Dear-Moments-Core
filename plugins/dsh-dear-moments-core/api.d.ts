import type { Context } from "@deepseek-ai/cordis";
export interface DearMomentsMemory {
  search(query: string, signal?: AbortSignal): Promise<unknown[]>;
  source(id: string, signal?: AbortSignal): Promise<unknown>;
  status(signal?: AbortSignal): Promise<unknown>;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    dearMomentsMemory: DearMomentsMemory;
  }
}
export const name: string;
export const inject: string[];
export function apply(
  ctx: Context,
  config?: { autoCapture?: boolean; coreFile?: string; queueFile?: string },
): void;
