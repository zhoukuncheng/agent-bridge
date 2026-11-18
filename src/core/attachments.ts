import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SlackApi, SlackFile } from "../slack/api.ts";

export interface SavedFile {
  path: string;
  name: string;
  mimetype?: string;
  size: number;
}

/**
 * Downloads a message's attachments into a per-thread folder outside any repository and
 * returns where they landed; files that could not be fetched are reported, not fatal.
 */
export async function saveAttachments(
  api: SlackApi,
  files: SlackFile[],
  rootDir: string,
  channel: string,
  threadTs: string,
  maxBytes: number,
): Promise<{ saved: SavedFile[]; failed: string[] }> {
  const dir = join(rootDir, `${channel}-${threadTs}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const saved: SavedFile[] = [];
  const failed: string[] = [];
  for (const file of files) {
    const safe = basename(file.name || file.id).replace(/[^\w.\-]+/g, "_").slice(0, 120) || file.id;
    const path = join(dir, `${file.id}-${safe}`);
    try {
      const size = await api.downloadFile(file, path, maxBytes);
      saved.push({ path, name: file.name, mimetype: file.mimetype, size });
    } catch (err) {
      rmSync(path, { force: true });
      failed.push(`${file.name}: ${(err as Error).message}`);
    }
  }
  return { saved, failed };
}

export function describeAttachments(saved: SavedFile[]): string {
  if (!saved.length) return "";
  const lines = saved.map((f) => `- ${f.path} (${f.mimetype ?? "unknown type"}, ${f.size} bytes, sent as "${f.name}")`);
  return `\n\nThe user attached ${saved.length === 1 ? "a file" : "files"}, saved locally (read them with your tools):\n${lines.join("\n")}`;
}

/** Removes per-thread attachment folders older than the retention period. */
export function pruneAttachments(rootDir: string, retentionDays: number): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (const entry of entries) {
    const path = join(rootDir, entry);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // raced with another prune
    }
  }
  return removed;
}
