import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

// Each agent process gets its own systemd scope with a memory cap, so one runaway
// agent is killed alone instead of taking down the bridge's cgroup (or the desktop).

function findOnPath(name: string, skipDir: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || dir === skipDir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

export function systemdRunAvailable(): boolean {
  try {
    execFileSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "-p", "MemoryMax=64M", "--", "true"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export function scopeArgs(memoryMax: string, command: string, args: readonly string[]): string[] {
  return ["--user", "--scope", "--quiet", "--collect", "-p", `MemoryMax=${memoryMax}`, "-p", "MemorySwapMax=0", "--", command, ...args];
}

/**
 * Points OAR at wrapper scripts that start the real binary inside a capped scope.
 * `binaries` maps OAR's override variable (OAR_CLAUDE_BIN, ...) to the command name.
 */
export function installOarWrappers(memoryMax: string, wrapperDir: string, binaries: Record<string, string>): string[] {
  mkdirSync(wrapperDir, { recursive: true });
  const installed: string[] = [];
  for (const [envVar, name] of Object.entries(binaries)) {
    const real = process.env[envVar] && !process.env[envVar]!.startsWith(wrapperDir) ? process.env[envVar] : findOnPath(name, wrapperDir);
    if (!real) continue;
    const wrapper = join(wrapperDir, name);
    const quoted = scopeArgs(memoryMax, real, []).map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    writeFileSync(wrapper, `#!/bin/sh\nexec systemd-run ${quoted} "$@"\n`);
    chmodSync(wrapper, 0o755);
    process.env[envVar] = wrapper;
    installed.push(`${name} → ${real}`);
  }
  return installed;
}
