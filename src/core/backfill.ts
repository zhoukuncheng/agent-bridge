import type { Config } from "../config.ts";
import type { ReplyMessage, SlackApi } from "../slack/api.ts";
import type { Store } from "../store.ts";
import type { InboundMessage, Router } from "./router.ts";

const handledSubtypes = new Set([undefined, "file_share", "thread_broadcast"]);

/**
 * Socket Mode can drop events (across reconnects, or while the bridge is down). This looks
 * back over the owner's DM and the bridge's recently active threads and routes any message
 * that was never handled. The router's persistent claim keeps everything handled once.
 * Mentions in channel messages outside the bridge's threads are not covered.
 */
export class Backfill {
  private dm: string | undefined;
  private running = false;
  private readonly deps: { api: SlackApi; store: Store; router: Router; config: Config; botUserId: string };

  constructor(deps: { api: SlackApi; store: Store; router: Router; config: Config; botUserId: string }) {
    this.deps = deps;
  }

  private toInbound(m: ReplyMessage, channel: string, channelType: string): InboundMessage | undefined {
    if (m.bot_id || !m.user || !handledSubtypes.has(m.subtype)) return undefined;
    if (!this.deps.config.allowUsers.includes(m.user)) return undefined;
    return { channel, channelType, user: m.user, text: m.text, ts: m.ts, ...(m.thread_ts ? { threadTs: m.thread_ts } : {}), ...(m.files?.length ? { files: m.files } : {}) };
  }

  /** Routes unhandled messages newer than `sinceMs`; returns how many were looked at. */
  async run(sinceMs: number): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const { api, store, router, config } = this.deps;
    const oldest = (sinceMs / 1000).toFixed(6);
    const found: InboundMessage[] = [];
    try {
      this.dm ??= await api.openDm(config.ownerUserId);
      for (const m of await api.history(this.dm, oldest)) {
        const msg = this.toInbound(m, this.dm, "im");
        if (msg) found.push(msg);
      }
      // Replies only show up in their threads; check the threads the bridge used lately.
      for (const thread of store.recentThreads(Math.min(sinceMs, Date.now() - 24 * 3_600_000))) {
        const replies = await api.replies(thread.channel, thread.thread_ts).catch(() => []);
        for (const m of replies) {
          if (m.ts === thread.thread_ts || Number(m.ts) <= Number(oldest)) continue;
          const msg = this.toInbound(m, thread.channel, thread.channel.startsWith("D") ? "im" : "channel");
          if (msg) found.push({ ...msg, threadTs: thread.thread_ts });
        }
      }
      found.sort((a, b) => Number(a.ts) - Number(b.ts));
      for (const msg of found) await router.handle(msg);
      return found.length;
    } catch (err) {
      console.warn("backfill failed", err);
      return found.length;
    } finally {
      this.running = false;
    }
  }
}
