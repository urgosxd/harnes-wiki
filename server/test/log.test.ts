import { test } from "node:test";
import assert from "node:assert/strict";
import { Logger, redact } from "../src/log.ts";

function captured() {
  const lines: string[] = [];
  const logger = new Logger({ level: "debug", sink: (line) => lines.push(line) });
  return { lines, logger, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

test("emits one JSON object per line with time, level and message", () => {
  const { logger, parsed } = captured();
  logger.info("started", { port: 8080 });

  const [record] = parsed();
  assert.equal(record?.level, "info");
  assert.equal(record?.message, "started");
  assert.equal(record?.port, 8080);
  assert.match(String(record?.time), /^\d{4}-\d{2}-\d{2}T/);
});

test("respects the level threshold", () => {
  const lines: string[] = [];
  const logger = new Logger({ level: "warn", sink: (line) => lines.push(line) });
  logger.debug("noise");
  logger.info("also noise");
  logger.warn("keep me");
  logger.error("keep me too");

  assert.equal(lines.length, 2);
});

test("redacts secrets by key name, at any depth", () => {
  const redacted = redact({
    user: "alice",
    token: "super-secret",
    nested: { apiKey: "sk-123", password: "pw", keep: 1 },
  });

  assert.equal(redacted.user, "alice");
  assert.equal(redacted.token, "[redacted]");
  assert.deepEqual(redacted.nested, { apiKey: "[redacted]", password: "[redacted]", keep: 1 });
});

test("serializes an Error without losing its message", () => {
  const redacted = redact({ error: new TypeError("boom") });
  assert.deepEqual(redacted.error, { name: "TypeError", message: "boom" });
});

test("keeps arrays intact", () => {
  const redacted = redact({ tags: ["a", "b"] });
  assert.deepEqual(redacted.tags, ["a", "b"]);
});

test("a child logger carries its base fields", () => {
  const { logger, parsed } = captured();
  const child = logger.child({ conversationId: "c1" });
  child.emit("info", "turn started", { runId: "r1" });

  const [record] = parsed();
  assert.equal(record?.conversationId, "c1");
  assert.equal(record?.runId, "r1");
});
