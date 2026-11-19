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
    if (!value) return `当前 provider：${current.provider}。可选 codex、antigravity（agy）。`;
    const provider = providerId(value.toLowerCase());
    await catalog(provider, cwd, cfg.fullAccess);
    store.setMeta(key, JSON.stringify({ ...saved, provider }));
    return `当前 provider：${provider}`;
  }
  const models = await catalog(current.provider, cwd, cfg.fullAccess);
  const active = current.model ? models.find(m => m.id === current.model) : models.find(m => m.default);
  const selected = { ...current };
  if (command === "model") {
    if (!value) return `当前模型：${current.model ?? active?.id ?? "原生默认"}\n${models.map(m => m.id).join("\n")}`;
    const model = models.find(m => m.id === value);
    if (!model) throw new Error("模型不在当前 provider 的可用列表，请使用 /model 查看。");
    selected.model = model.id;
    selected.effort = model.effortLevels?.includes(current.effort ?? "") ? current.effort : model.defaultEffort;
  } else {
    const levels = active?.effortLevels ?? [];
    if (!value) return `当前推理档位：${current.effort ?? active?.defaultEffort ?? "原生默认"}\n可选：${levels.join("、") || "未提供，请先用 /model 选择支持推理档位的模型"}`;
    if (!levels.includes(value)) throw new Error("当前模型不支持该推理档位，请使用 /reasoning 查看。");
    selected.effort = value;
  }
  store.setMeta(key, JSON.stringify({ ...saved, settings: { ...saved.settings, [selected.provider]: selected } }));
  return `${selected.provider} · ${selected.model ?? active?.id ?? "原生默认模型"} · ${selected.effort ?? "原生默认推理档位"}`;
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
  if (!entry) throw new Error(`${provider} 可选模型：${models.map(m => m.id).join("、")}`);
  const levels = entry.effortLevels ?? [];
  if (requestedEffort && !levels.includes(requestedEffort)) throw new Error(`${model} 可选推理档位：${levels.join("、") || "仅原生默认"}`);
  const selection = { provider, model, effort: requestedEffort ?? entry.defaultEffort };
  store.setMeta(cronKey, JSON.stringify(selection));
  return selection;
}

export function describeCronSelection(s: Selection) {
  return `定时任务统一设置：${s.provider} · ${s.model ?? "原生默认模型"} · ${s.effort ?? "原生默认推理档位"}`;
}
