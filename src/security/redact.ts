import type { ReplyMessage, SlackApi, SlackFile, StreamChunk } from "../slack/api.ts";

// Masks credentials in everything the bridge posts. The agent runs as the same user as the
// bridge, so it can read secrets; this keeps them from reaching Slack in recognisable form.

const patterns: [string, RegExp][] = [
  ["slack-token", /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g],
  ["slack-app-token", /\bxapp-\d-[A-Za-z0-9-]{10,}/g],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["api-key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
];

// `password=...`, `"api_key": "..."`: keep the name, mask the value.
const assignment = /\b((?:[A-Za-z0-9]+_)*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;]{8,})/gi;

const secretEnvName = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

export class Redactor {
  private readonly exact: string[];

  /** `values`: exact secrets to mask wherever they appear (the bridge's own tokens, secret-looking env values). */
  constructor(values: Iterable<string> = []) {
    this.exact = [...new Set([...values].filter((v) => v && v.length >= 12))].sort((a, b) => b.length - a.length);
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): Redactor {
    const values = Object.entries(env)
      .filter(([name, value]) => value && secretEnvName.test(name))
      .map(([, value]) => value!);
    return new Redactor(values);
  }

  redact(text: string): string {
    let out = text;
    for (const value of this.exact) out = out.split(value).join("[redacted]");
    for (const [kind, pattern] of patterns) out = out.replace(pattern, `[redacted:${kind}]`);
    out = out.replace(assignment, (_m, name: string, sep: string) => `${name}${sep}[redacted]`);
    return out;
  }
}

/** Wraps a SlackApi so every outgoing text, stream chunk and task card is redacted. */
export class RedactingSlackApi implements SlackApi {
  private readonly inner: SlackApi;
  private readonly redactor: Redactor;

  constructor(inner: SlackApi, redactor: Redactor) {
    this.inner = inner;
    this.redactor = redactor;
  }

  private chunk(chunk: StreamChunk): StreamChunk {
    if (chunk.type === "markdown_text") return { ...chunk, text: this.redactor.redact(chunk.text) };
    return {
      ...chunk,
      title: this.redactor.redact(chunk.title),
      ...(chunk.details !== undefined ? { details: this.redactor.redact(chunk.details) } : {}),
      ...(chunk.output !== undefined ? { output: this.redactor.redact(chunk.output) } : {}),
    };
  }

  postMessage(args: { channel: string; thread_ts?: string; text: string }) {
    return this.inner.postMessage({ ...args, text: this.redactor.redact(args.text) });
  }
  update(args: { channel: string; ts: string; text: string }) {
    return this.inner.update({ ...args, text: this.redactor.redact(args.text) });
  }
  startStream(args: { channel: string; thread_ts: string; recipient_user_id?: string; recipient_team_id?: string }) {
    return this.inner.startStream(args);
  }
  appendStream(args: { channel: string; ts: string; chunks: StreamChunk[] }) {
    return this.inner.appendStream({ ...args, chunks: args.chunks.map((c) => this.chunk(c)) });
  }
  stopStream(args: { channel: string; ts: string }) {
    return this.inner.stopStream(args);
  }
  openDm(userId: string) {
    return this.inner.openDm(userId);
  }
  replies(channel: string, ts: string): Promise<ReplyMessage[]> {
    return this.inner.replies(channel, ts);
  }
  userName(userId: string) {
    return this.inner.userName(userId);
  }
  history(channel: string, oldestTs: string): Promise<ReplyMessage[]> {
    return this.inner.history(channel, oldestTs);
  }
  downloadFile(file: SlackFile, dest: string, maxBytes: number) {
    return this.inner.downloadFile(file, dest, maxBytes);
  }
}
