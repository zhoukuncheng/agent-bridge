import type { Runtime } from "@botiverse/oar";
import type { Config } from "../config.ts";
import { bridgeSecretEnv } from "../agents/types.ts";

export type Provider = "antigravity" | "codex";
export type TelegramConfig = NonNullable<Config["telegram"]>;
export interface Selection { provider: Provider; model?: string; effort?: string }

export function providerId(value: string): Provider {
  if (value === "agy" || value === "antigravity") return "antigravity";
  if (value === "codex") return value;
  throw new Error("可选 provider：codex、antigravity（agy）");
}

export function defaults(config: TelegramConfig, provider = providerId(config.agent ?? "codex")): Selection {
  const configured = provider === providerId(config.agent ?? "codex")
    ? { model: config.model, effort: config.effort } : {};
  return { provider, ...configured, ...config.providers?.[provider] };
}

const stripped = Object.fromEntries(bridgeSecretEnv.map(key => [key, null]));
// OAR's Codex default overrides native sandbox settings. This dedicated host
// inherits them and opts into full access explicitly for authorized deployments.
process.env.OAR_CODEX_SANDBOX = "inherit";

function checkAccess(provider: Provider, fullAccess?: boolean) {
  // OAR's agy ACP host always auto-approves permission requests.
  if (provider === "antigravity" && !fullAccess) throw new Error("当前 OAR Antigravity 需要显式配置 fullAccess，已停止启动。");
}

async function installed(provider: Provider) {
  const runtime: Runtime = provider === "codex"
    ? (await import("@botiverse/oar/runtimes/codex")).codexRuntime.withPlacement("isolated")
    : (await import("@botiverse/oar/runtimes/antigravity")).antigravityRuntime.withPlacement("isolated");
  const installation = await runtime.installation?.();
  if (installation?.kind !== "available") throw new Error(`${provider} installation unavailable`);
  return { runtime, installation };
}

export async function modelCatalog(provider: Provider, cwd: string, fullAccess?: boolean) {
  checkAccess(provider, fullAccess);
  const { runtime, installation } = await installed(provider);
  const result = await runtime.listModels?.(installation, { cwd, env: stripped, timeoutMs: 30000 });
  if (result?.kind !== "ok") throw new Error(`${provider} 模型列表不可用 (${result?.kind ?? "unsupported"})`);
  return result.models.filter(m => !m.disabled);
}

export async function providerReply(selection: Selection, prompt: string, options: {
  cwd: string; resume?: string; fullAccess?: boolean; env: Record<string,string>; signal: AbortSignal;
}) {
  const { provider, model, effort } = selection;
  const { signal, cwd, resume, fullAccess } = options;
  checkAccess(provider, fullAccess);
  signal.throwIfAborted();
  const { runtime, installation } = await installed(provider);
  const { promptAndWait } = await import("@botiverse/oar/observe");
  signal.throwIfAborted();
  const session = await runtime.session(installation, {
    cwd, resume, model, effort, retainedBytes: 512 * 1024,
    ...(provider === "codex" ? { endTurnProcessesOnAbort: true,
      launchArgs: fullAccess ? ["-c", 'sandbox_mode="danger-full-access"'] : [] } : {}),
    env: { ...options.env, ...stripped },
  });
  try {
    signal.throwIfAborted();
    let answer = "", failedTool = false;
    let messageId: string | undefined;
    session.events(event => {
      if (event.sessionId !== session.id || event.agentPath.length) return;
      if (provider === "antigravity" && event.kind === "tool_call_ended" && event.result === "failed") failedTool = true;
      if (event.kind !== "text_delta" || (event.phase && event.phase !== "final_answer")) return;
      if (messageId !== event.messageId) answer = "";
      messageId = event.messageId;
      answer += event.text;
    });
    const run = await promptAndWait(session, prompt, { signal });
    signal.throwIfAborted();
    if (run.kind === "rejected") throw new Error(run.reason);
    if (run.kind !== "ended") throw new Error(`${provider}: ${run.kind}`);
    if (run.outcome.kind === "failed") throw new Error(run.outcome.reason);
    if (provider === "antigravity") {
      // OAR 0.118 maps ACP refusals and output limits to a completed turn.
      // Inspect the native terminal receipt before publishing a partial answer.
      const receipt = session.records().findLast(r => r.kind === "frame" && r.sessionId === session.id &&
        !r.agentPath.length && r.body.type === "session/prompt");
      const native = receipt?.kind === "frame" ? receipt.body.native : undefined;
      const reason = native && typeof native === "object" && "stopReason" in native ? native.stopReason : undefined;
      if (reason !== "end_turn") throw new Error(`Antigravity ended with ${reason ?? "no ACP stop reason"}`);
      if (failedTool) throw new Error("Antigravity reported an unsuccessful tool action");
    }
    if (run.outcome.kind !== "completed" || !answer.trim()) throw new Error(`${provider} ended without a final answer`);
    return { answer, sessionId: session.id, model: session.model().value };
  } finally {
    await session.dispose();
  }
}
