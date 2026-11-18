import assert from "node:assert/strict";
import { test } from "node:test";
import { secretPathRules } from "../src/agents/oar.ts";
import { RedactingSlackApi, Redactor } from "../src/security/redact.ts";
import { slackFileUrl } from "../src/slack/api.ts";
import { FakeSlack } from "./fakes.ts";

test("known credential shapes and exact secret values are masked", () => {
  const r = new Redactor(["s3cr3t-value-from-env"]);
  const input = [
    "slack xoxb-123456789012-abcdefABCDEF and xapp-1-A0AAAA-123-abcdef",
    "aws AKIAABCDEFGHIJKLMNOP gh ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    'env DB_PASSWORD=hunter2hunter2 and "api_key": "abcd1234efgh"',
    "plain s3cr3t-value-from-env here",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  const out = r.redact(input);
  for (const leaked of ["xoxb-1234", "xapp-1-A0", "AKIAABCD", "ghp_abcd", "sk-ant-api03", "eyJhbGci", "hunter2", "abcd1234efgh", "s3cr3t-value", "AAAA"]) {
    assert.ok(!out.includes(leaked), `${leaked} leaked: ${out}`);
  }
  assert.match(out, /DB_PASSWORD=\[redacted\]/);
  assert.match(out, /\[redacted:slack-token\]/);
});

test("ordinary text is left alone", () => {
  const r = new Redactor([]);
  const text = "the password field is required; token counts: 1234; see https://example.com/a?b=c and commit 0952919";
  assert.equal(r.redact(text), text);
});

test("secret-looking environment variables become exact-match secrets", () => {
  const r = Redactor.fromEnvironment({ SLACK_BOT_TOKEN: "xoxb-not-a-pattern-match-but-long", HOME: "/home/someone-long-path" });
  assert.equal(r.redact("t=xoxb-not-a-pattern-match-but-long home=/home/someone-long-path"), "t=[redacted] home=/home/someone-long-path");
});

test("every outgoing Slack text, stream chunk and task card is redacted", async () => {
  const slack = new FakeSlack();
  const api = new RedactingSlackApi(slack, new Redactor(["top-secret-value-123"]));
  await api.postMessage({ channel: "C1", text: "a top-secret-value-123" });
  await api.appendStream({
    channel: "C1",
    ts: "1",
    chunks: [
      { type: "markdown_text", text: "b top-secret-value-123" },
      { type: "task_update", id: "t1", title: "cat top-secret-value-123", status: "complete", details: "top-secret-value-123", output: "top-secret-value-123" },
    ],
  });
  assert.ok(!JSON.stringify(slack.calls).includes("top-secret-value-123"));
});

test("secret paths become Claude Read/Edit deny rules", () => {
  assert.deepEqual(secretPathRules(["~/.ssh/**", "/proc/*/environ"]), ["Read(~/.ssh/**)", "Edit(~/.ssh/**)", "Read(//proc/*/environ)", "Edit(//proc/*/environ)"]);
});

test("the bot token is only sent to Slack's own https hosts", () => {
  assert.equal(slackFileUrl("https://files.slack.com/files-pri/T1-F1/download/a.txt"), "https://files.slack.com/files-pri/T1-F1/download/a.txt");
  assert.throws(() => slackFileUrl("http://files.slack.com/x"), /refusing/);
  assert.throws(() => slackFileUrl("https://files.slack.com.evil.dev/x"), /refusing/);
  assert.throws(() => slackFileUrl("https://evil.dev/?files.slack.com"), /refusing/);
});
