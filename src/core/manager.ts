import type { AgentDriver } from "../agents/types.ts";
import type { SlackApi } from "../slack/api.ts";
import type { RenderOptions, ThreadTarget } from "../slack/render.ts";
import type { Store, ThreadKind } from "../store.ts";
import { SessionBinding } from "./binding.ts";

export interface SessionSpec {
  agent: string;
  cwd: string;
  model?: string;
  kind: ThreadKind;
}

export interface ManagerOptions {
  idleMinutes: number;
  maxLiveSessions: number;
  renderOptions?: Partial<RenderOptions>;
}

const keyOf = (channel: string, threadTs: string) => `${channel}:${threadTs}`;

/**
 * Owns live agent sessions, one per Slack thread. A session idle past `idleMinutes`
 * is disposed; the next message in its thread resumes it from the stored session id.
 */
export class SessionManager {
  private live = new Map<string, SessionBinding>();
  private opening = new Map<string, Promise<SessionBinding>>();
  private reaper: NodeJS.Timeout | undefined;

  private readonly drivers: Record<string, AgentDriver>;
  private readonly store: Store;
  private readonly api: SlackApi;
  private readonly options: ManagerOptions;

  constructor(drivers: Record<string, AgentDriver>, store: Store, api: SlackApi, options: ManagerOptions) {
    this.drivers = drivers;
    this.store = store;
    this.api = api;
    this.options = options;
  }

  start(): void {
    this.reaper = setInterval(() => void this.reapIdle(), 60_000);
    this.reaper.unref();
  }

  get(channel: string, threadTs: string): SessionBinding | undefined {
    return this.live.get(keyOf(channel, threadTs));
  }

  liveCount(): number {
    return this.live.size;
  }

  /** Whether the thread belongs to the bridge (live now, or stored from earlier). */
  owns(channel: string, threadTs: string): boolean {
    return this.live.has(keyOf(channel, threadTs)) || this.store.getThread(channel, threadTs) !== undefined;
  }

  /**
   * Returns the thread's live session, resuming the stored one or opening a new one.
   * `spec` is used only when the thread has no stored session.
   */
  async getOrOpen(target: ThreadTarget, spec: SessionSpec): Promise<{ binding: SessionBinding; created: boolean; resumed: boolean }> {
    const key = keyOf(target.channel, target.threadTs);
    const existing = this.live.get(key);
    if (existing && !existing.exited) return { binding: existing, created: false, resumed: false };
    const inflight = this.opening.get(key);
    if (inflight) return { binding: await inflight, created: false, resumed: false };

    const stored = this.store.getThread(target.channel, target.threadTs);
    const effective: SessionSpec = stored ? { agent: stored.agent, cwd: stored.cwd, model: stored.model ?? undefined, kind: stored.kind } : spec;
    const driver = this.drivers[effective.agent];
    if (!driver) throw new Error(`unknown agent "${effective.agent}" (configured: ${Object.keys(this.drivers).join(", ")})`);

    const open = (async () => {
      await this.makeRoom();
      const session = await driver.open({ cwd: effective.cwd, model: effective.model, resume: stored?.session_id });
      const binding = new SessionBinding(session, this.api, target, this.options.renderOptions);
      binding.onExit = () => {
        if (this.live.get(key) === binding) this.live.delete(key);
      };
      this.live.set(key, binding);
      this.store.upsertThread({
        channel: target.channel,
        thread_ts: target.threadTs,
        agent: effective.agent,
        session_id: session.id,
        cwd: effective.cwd,
        model: effective.model ?? null,
        kind: effective.kind,
      });
      return binding;
    })();
    this.opening.set(key, open);
    try {
      return { binding: await open, created: !stored, resumed: Boolean(stored) };
    } finally {
      this.opening.delete(key);
    }
  }

  /** Evicts the least recently used idle session when at capacity. */
  private async makeRoom(): Promise<void> {
    if (this.live.size < this.options.maxLiveSessions) return;
    const idle = [...this.live.entries()].filter(([, b]) => !b.session.busy()).sort((a, b) => a[1].lastActive - b[1].lastActive);
    const victim = idle[0];
    if (!victim) throw new Error(`all ${this.live.size} live sessions are busy (maxLiveSessions=${this.options.maxLiveSessions}); try again later or !stop one`);
    await this.close(victim[0]);
  }

  private async close(key: string): Promise<void> {
    const binding = this.live.get(key);
    if (!binding) return;
    this.live.delete(key);
    try {
      await binding.dispose();
    } catch (err) {
      console.warn("dispose failed", key, err);
    }
  }

  /** Disposes a thread's live session; the stored id stays, so a later message resumes it. */
  async release(channel: string, threadTs: string): Promise<boolean> {
    const key = keyOf(channel, threadTs);
    const had = this.live.has(key);
    await this.close(key);
    return had;
  }

  async reapIdle(now = Date.now()): Promise<void> {
    const cutoff = now - this.options.idleMinutes * 60_000;
    for (const [key, binding] of this.live) {
      if (!binding.session.busy() && binding.lastActive < cutoff) await this.close(key);
    }
  }

  async shutdown(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    await Promise.all([...this.live.keys()].map((key) => this.close(key)));
  }
}
