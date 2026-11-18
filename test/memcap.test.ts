import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installOarWrappers, scopeArgs } from "../src/agents/memcap.ts";

test("scope arguments cap memory and disable swap", () => {
  assert.deepEqual(scopeArgs("8G", "/bin/omp", ["acp"]), ["--user", "--scope", "--quiet", "--collect", "-p", "MemoryMax=8G", "-p", "MemorySwapMax=0", "--", "/bin/omp", "acp"]);
});

test("wrappers point OAR at the real binary inside a capped scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "memcap-"));
  const bin = join(dir, "bin");
  const wrappers = join(dir, "wrappers");
  mkdirSync(bin);
  writeFileSync(join(bin, "fakeagent"), "#!/bin/sh\n");
  chmodSync(join(bin, "fakeagent"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${wrappers}:${bin}`;
  delete process.env.OAR_FAKE_BIN;
  try {
    const installed = installOarWrappers("2G", wrappers, { OAR_FAKE_BIN: "fakeagent", OAR_MISSING_BIN: "no-such-binary" });
    assert.deepEqual(installed, [`fakeagent → ${join(bin, "fakeagent")}`]);
    assert.equal(process.env.OAR_FAKE_BIN, join(wrappers, "fakeagent"));
    const script = readFileSync(join(wrappers, "fakeagent"), "utf8");
    assert.match(script, /exec systemd-run '--user' '--scope' .*'MemoryMax=2G'.*'--' '.*\/bin\/fakeagent' "\$@"/);
    assert.equal(process.env.OAR_MISSING_BIN, undefined);
  } finally {
    process.env.PATH = savedPath;
    delete process.env.OAR_FAKE_BIN;
  }
});
