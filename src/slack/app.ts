import { App, LogLevel } from "@slack/bolt";
import type { InboundMessage } from "../core/router.ts";

const handledSubtypes = new Set([undefined, "file_share", "thread_broadcast"]);

/** Converts a Slack `message` or `app_mention` event to the router's shape; undefined when it should be ignored. */
export function toInbound(event: Record<string, any>, teamId?: string): InboundMessage | undefined {
  if (event.bot_id || event.bot_profile) return undefined;
  if (!handledSubtypes.has(event.subtype)) return undefined;
  if (typeof event.user !== "string" || typeof event.text !== "string" || typeof event.ts !== "string") return undefined;
  const channel = String(event.channel);
  return {
    channel,
    channelType: event.channel_type ?? (channel.startsWith("D") ? "im" : "channel"),
    user: event.user,
    text: event.text,
    ts: event.ts,
    threadTs: event.thread_ts,
    teamId: event.team ?? teamId,
  };
}

/**
 * Socket Mode app: no public endpoint needed. Each event is acknowledged by Bolt and
 * routed without waiting, so a long agent turn never delays the ack.
 */
export function createSlackApp(opts: { botToken: string; appToken: string; teamId?: string; onMessage: (msg: InboundMessage) => Promise<void> }): App {
  const app = new App({ token: opts.botToken, appToken: opts.appToken, socketMode: true, logLevel: LogLevel.WARN });
  const dispatch = (event: Record<string, any>) => {
    const msg = toInbound(event, opts.teamId);
    if (msg) void opts.onMessage(msg).catch((err) => console.error("message handling failed", err));
  };
  // A mention in a channel arrives as both `message` and `app_mention`; the router dedupes by ts.
  app.event("message", async ({ event }) => dispatch(event as Record<string, any>));
  app.event("app_mention", async ({ event }) => dispatch(event as Record<string, any>));
  return app;
}
