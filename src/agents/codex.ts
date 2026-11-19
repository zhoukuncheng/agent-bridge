import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { bridgeSecretEnv } from "./types.ts";

export interface CodexOptions {
  cwd: string;
  model: string;
  effort: string;
  fullAccess?: boolean;
  resume?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** One CLI process per turn. Only the native Codex conversation ID survives between turns. */
export async function runCodex(prompt: string, options: CodexOptions) {
  const args = ["exec", "--json", "--skip-git-repo-check", "-m", options.model, "-c", "model_reasoning_effort=" + JSON.stringify(options.effort)];
  if (options.fullAccess) args.push("--dangerously-bypass-approvals-and-sandbox");
  if (options.resume) args.push("resume", options.resume);
  args.push("-");
  const env = { ...process.env, ...options.env };
  for (const name of bridgeSecretEnv) delete env[name];
  options.signal?.throwIfAborted();
  const child = spawn("codex", args, { cwd: options.cwd, env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const abort = () => {
    if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const result = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let sessionId = options.resume;
  let answer = "", error = "", completed = false;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started") sessionId = event.thread_id;
      if (event.type === "item.completed" && event.item?.type === "agent_message") answer = event.item.text;
      if (event.type === "turn.failed") error = event.error?.message ?? "turn failed";
      if (event.type === "turn.completed") completed = true;
    } catch { /* non-protocol diagnostic */ }
  });
  child.stdin.on("error", () => {}); // close/error determines the turn outcome
  child.stdin.end(prompt);
  try {
    const code = await result;
    options.signal?.throwIfAborted();
    if (code !== 0 || !completed || !answer || !sessionId) throw new Error(error || `Codex ended without a final answer (exit ${code})`);
    return { answer, sessionId };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    lines.close();
  }
}
