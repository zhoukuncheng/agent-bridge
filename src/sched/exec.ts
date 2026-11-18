import { spawn } from "node:child_process";
import { bridgeSecretEnv } from "../agents/types.ts";

export interface ExecResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Runs a shell command the way cc-connect's exec cron did: `sh -c` in the work dir, stdout+stderr together. */
export function runShell(command: string, cwd: string, timeoutMinutes: number): Promise<ExecResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of bridgeSecretEnv) delete env[name];
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // detached: the command runs in its own process group, so kill the whole group.
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, timeoutMinutes * 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `failed to start: ${err.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}
