import type { Store } from "../store.ts";
import { defaults, modelCatalog, providerId, type Provider, type Selection, type TelegramConfig } from "./providers.ts";

interface Preferences { provider?: Provider; settings?: Partial<Record<Provider, Selection>> }
function read(store: Store, key: string): Preferences {
  return JSON.parse(store.getMeta(key) ?? "{}");
}
const prefKey = (chat: string, topic: string) => `telegram:preferences:${chat}:${topic}`;

export function selectionFor(store: Store, config: TelegramConfig, chat: string, topic: string): Selection {
  const saved = read(store, prefKey(chat, topic));
  const fallback = defaults(config, saved.provider);
  return saved.settings?.[fallback.provider] ?? fallback;
}

export async function changeSelection(store: Store, cfg: TelegramConfig, chat: string, topic: string, cwd: string,
  command: "provider" | "model" | "reasoning", value: string, catalog = modelCatalog): Promise<string> {
  const key = prefKey(chat, topic);
  const saved = read(store, key);
  const current = selectionFor(store, cfg, chat, topic);
  if (command === "provider") {
    if (!value) return `Provider: ${current.provider}. Available: codex, antigravity (agy).`;
    const provider = providerId(value.toLowerCase());
    await catalog(provider, cwd, cfg.fullAccess);
    store.setMeta(key, JSON.stringify({ ...saved, provider }));
    return `Provider: ${provider}`;
  }
  const models = await catalog(current.provider, cwd, cfg.fullAccess);
  const active = current.model ? models.find(m => m.id === current.model) : models.find(m => m.default);
  const selected = { ...current };
  if (command === "model") {
    if (!value) return `Model: ${current.model ?? active?.id ?? "provider default"}\n${models.map(m => m.id).join("\n")}`;
    const model = models.find(m => m.id === value);
    if (!model) throw new Error("That model is not available for this provider; send /model to list the models.");
    selected.model = model.id;
    selected.effort = model.effortLevels?.includes(current.effort ?? "") ? current.effort : model.defaultEffort;
  } else {
    const levels = active?.effortLevels ?? [];
    if (!value) return `Reasoning: ${current.effort ?? active?.defaultEffort ?? "provider default"}\nAvailable: ${levels.join(", ") || "none; pick a model that supports reasoning levels with /model first"}`;
    if (!levels.includes(value)) throw new Error("The current model does not support that reasoning level; send /reasoning to list the levels.");
    selected.effort = value;
  }
  store.setMeta(key, JSON.stringify({ ...saved, settings: { ...saved.settings, [selected.provider]: selected } }));
  return `${selected.provider} · ${selected.model ?? active?.id ?? "default model"} · ${selected.effort ?? "default reasoning"}`;
}

export const threadKey = (topic: string, provider: Provider) => `${topic}:${provider}`;
export function forgetSession(store: Store, chat: string, topic: string, provider: Provider) {
  store.db.prepare("DELETE FROM threads WHERE channel=? AND (thread_ts=? OR (thread_ts=? AND agent IN (?,?)))")
    .run(chat, threadKey(topic, provider), topic, provider, provider === "antigravity" ? "agy" : provider);
}

const cronKey = "telegram:cron:selection";
export const cronUsage = "/cron set <provider> <model> [reasoning]";

export function cronSelection(store: Store, config: TelegramConfig): Selection {
  const saved = store.getMeta(cronKey);
  return saved ? JSON.parse(saved) : defaults(config);
}

export async function setCronSelection(store: Store, config: TelegramConfig, cwd: string, input: string, catalog = modelCatalog): Promise<Selection> {
  const [action, backend, model, requestedEffort, ...extra] = input.trim().split(/\s+/);
  if (action !== "set" || !backend || !model || extra.length) throw new Error(cronUsage);
  const provider = providerId(backend.toLowerCase());
  const models = await catalog(provider, cwd, config.fullAccess);
  const entry = models.find(m => m.id === model);
  if (!entry) throw new Error(`${provider} models: ${models.map(m => m.id).join(", ")}`);
  const levels = entry.effortLevels ?? [];
  if (requestedEffort && !levels.includes(requestedEffort)) throw new Error(`${model} reasoning levels: ${levels.join(", ") || "provider default only"}`);
  const selection = { provider, model, effort: requestedEffort ?? entry.defaultEffort };
  store.setMeta(cronKey, JSON.stringify(selection));
  return selection;
}

export function describeCronSelection(s: Selection) {
  return `Schedules run on: ${s.provider} · ${s.model ?? "default model"} · ${s.effort ?? "default reasoning"}`;
}
