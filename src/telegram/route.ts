import type { Target } from "./api.ts";

export interface TelegramMessage {
  from?: { id: number; is_bot?: boolean };
  sender_chat?: unknown;
  chat: { id: number; type: string };
  message_id: number;
  message_thread_id?: number;
  text?: string;
  caption?: string;
  rich_message?: { blocks: unknown[] };
  reply_to_message?: { from?: { id: number } };
}

// Telegram represents incoming rich text as nested blocks, arrays and text leaves.
function richText(value: unknown, depth = 0): string {
  if (depth > 32 || !value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(v => richText(v, depth + 1)).join("");
  if (typeof value !== "object") return "";
  const fields = value as Record<string, unknown>;
  return ["text", "texts", "blocks", "items", "cells", "caption"].filter(k => k in fields)
    .map(k => richText(fields[k], depth + 1)).join(" ");
}

export function route(m: TelegramMessage, owner: string, bot: { id: number; username: string }) {
  if (!m.from || String(m.from.id) !== owner || m.from.is_bot || m.sender_chat) return;
  const text = (m.text ?? m.caption ?? m.rich_message?.blocks.map(b => richText(b)).join("\n") ?? "").trim();
  const mention = new RegExp("(?<![a-z0-9_])@" + bot.username + "(?![a-z0-9_])", "i");
  const command = /^\/(\w+)(?:@(\w+))?(?:\s|$)/.exec(text);
  if (!text || (command?.[2] && command[2].toLowerCase() !== bot.username.toLowerCase())) return;
  if (m.chat.type === "private") {
    if (String(m.chat.id) !== owner) return;
  } else {
    if (!["group","supergroup"].includes(m.chat.type)) return;
    if (!mention.test(text) && m.reply_to_message?.from?.id !== bot.id && !command) return;
  }
  const target: Target = { chat_id: String(m.chat.id), message_thread_id: m.message_thread_id };
  // Remove addressing syntax only. Preserve handles inside the user's request.
  let prompt = text;
  if (command) prompt = text.slice(command[0].length);
  else if (m.chat.type !== "private" && text.search(mention) === 0) prompt = text.replace(mention, "");
  return { target, text: prompt.trim(), command: command?.[1], topic: String(m.message_thread_id ?? 0) };
}
