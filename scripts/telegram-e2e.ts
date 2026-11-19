// Sends two short messages to the configured owner using the production bot and its configured OAR provider.
// Keeps test runs, schedules and conversations in a temporary in-memory store.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { configuredBot, type Target, type Format } from "../src/telegram/api.ts";
import { TelegramService } from "../src/telegram/service.ts";
import { route } from "../src/telegram/route.ts";
const cfg = loadConfig(), store = new Store(":memory:");
const live = configuredBot();
const me = await live.call("getMe", {});
const receipts: number[] = [];
const outputs: string[] = [];
const verifier = {
  async send(target: Target, text: string, format: Format = "markdown") {
    const result = await live.send(target, text, format);
    assert.equal(String(result.chat.id), cfg.ownerUserId);
    receipts.push(result.message_id);
    outputs.push(text);
    console.log("receipt", result.message_id, format, result.rich_message ? "rich" : "text");
    return result;
  }
}
const service = new TelegramService(cfg, store, verifier);
const marker = "BRIDGE-" + randomUUID().slice(0, 8);
const owner = Number(cfg.ownerUserId);
const input = route({ chat: { id: owner, type: "private" }, from: { id: owner }, message_id: 1, text: "Remember " + marker + ". Reply with just this marker in bold Markdown." }, cfg.ownerUserId, me)!;
await service.turn(input.target, input.topic, input.text, { timeout: 3, resume: false });
await service.turn(input.target, input.topic, "Repeat the previous marker inside an HTML code element.", { timeout: 3, resume: true, format: "html" });
assert.equal(outputs.length, 2);
assert.ok(outputs.every(s => s.includes(marker)));
assert.notEqual(receipts[0], receipts[1]);
store.close();
