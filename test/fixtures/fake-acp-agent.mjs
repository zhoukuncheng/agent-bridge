// A scripted ACP agent for tests: replies "echo: <prompt>", runs one tool call for
// prompts containing TOOL (asking permission first), and hangs on HANG until cancelled.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const pendingClient = new Map();
const hanging = new Map();
let nextId = 1000;
const sessions = new Set();
const resumeOnly = process.argv.includes("--load-only") === false;

function ask(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pendingClient.set(id, resolve));
}

async function prompt(id, { sessionId, prompt }) {
  const text = prompt.map((p) => p.text).join("");
  if (text.includes("HANG")) {
    hanging.set(sessionId, id);
    return;
  }
  if (text.includes("TOOL")) {
    const decision = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "tc1" },
      options: [{ optionId: "rej", kind: "reject_once" }, { optionId: "ok", kind: "allow_once" }],
    });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "tc1", title: "$ echo hi", kind: "execute", status: "pending", rawInput: { command: "echo hi" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed", rawOutput: { content: [{ type: "text", text: `hi (${decision.outcome.optionId})` }] } });
  }
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo: " } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  update(sessionId, { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.01, currency: "USD" } });
  setTimeout(() => send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } } }), 5);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    pendingClient.get(msg.id)?.(msg.result);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: resumeOnly ? { resume: {} } : {} } } });
    case "session/new": {
      const sessionId = `fake-${process.pid}`;
      sessions.add(sessionId);
      return send({ id, result: { sessionId } });
    }
    case "session/resume":
      sessions.add(params.sessionId);
      return send({ id, result: {} });
    case "session/load":
      sessions.add(params.sessionId);
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY" } });
      return send({ id, result: {} });
    case "session/set_config_option":
      if (params.value === "bad-model") return send({ id, error: { code: -32602, message: "unknown model" } });
      return send({ id, result: { configOptions: [] } });
    case "session/prompt":
      return void prompt(id, params);
    case "session/cancel": {
      const pid = hanging.get(params.sessionId);
      if (pid !== undefined) {
        hanging.delete(params.sessionId);
        send({ id: pid, result: { stopReason: "cancelled" } });
      }
      return;
    }
    case "session/close":
      send({ id, result: {} });
      return setTimeout(() => process.exit(0), 5);
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `no ${method}` } });
  }
});
