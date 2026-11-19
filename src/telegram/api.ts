import { readFileSync } from "node:fs";
import { Redactor } from "../security/redact.ts";

export type Format = "markdown" | "html";
export interface Target { chat_id: string; message_thread_id?: number }
export class TelegramError extends Error {
  code: number;
  constructor(method: string, code: number, description: string) {
    super(`${method} (${code}): ${description}`);
    this.code = code;
  }
}

export class Telegram {
  private token: string;
  private redactor: Redactor;
  constructor(token: string) {
    if (!token) throw new Error("Telegram token is required");
    this.token = token;
    this.redactor = Redactor.fromEnvironment({ ...process.env, TELEGRAM_BOT_TOKEN: token });
  }

  async call(method: string, data: object, signal = AbortSignal.timeout(65_000)) {
    const form = data instanceof FormData;
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST", body: form ? data : JSON.stringify(data),
      headers: form ? undefined : { "Content-Type": "application/json" }, redirect: "error", signal,
    }).catch(() => { throw new Error(`Telegram ${method} connection failed`); });
    const body = await res.json() as { ok: boolean; result: any; error_code: number; description: string };
    if (!body.ok) throw new TelegramError(method, body.error_code, this.redactor.redact(body.description));
    return body.result;
  }

  async send(target: Target, raw: string, format: Format = "markdown") {
    const text = this.redactor.redact(raw);
    try {
      return await this.call("sendRichMessage", { ...target, rich_message: { [format]: text } });
    } catch (err) {
      if (!(err instanceof TelegramError) || ![400,404].includes(err.code)) throw err;
    }
    let last;
    // 2000 Unicode code points always fit the legacy 4096 UTF-16 unit limit.
    for (const part of text.match(/.{1,2000}/gsu) ?? []) last = await this.call("sendMessage", { ...target, text: part });
    return last;
  }
}

export function configuredBot() {
  return new Telegram(process.env.TELEGRAM_BOT_TOKEN ?? readFileSync(process.env.AGENT_BRIDGE_TOKEN_FILE!, "utf8").trim());
}
