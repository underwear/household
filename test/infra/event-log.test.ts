import { expect, test } from "bun:test";
import { formatEvent } from "../../src/infra/event-log";

test("untrusted proxy fields cannot inject terminal escapes or fake lines", () => {
  const line = formatEvent({
    type: "proxy",
    kind: "connect",
    ts: "2026-11-02T10:00:00.000Z",
    verdict: "DENY",
    source: "172.20.0.3",
    method: "CONNECT",
    target: "x\u001b[2J\n10:00:00 ALLOW house 'work'\u009b",
    reason: "bad",
  });
  expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  expect(line).toContain("x\\x1b[2J\\x0a10:00:00 ALLOW house 'work'\\x9b");
});

test("agent events read as one short line per event", () => {
  const line = formatEvent({
    type: "agent",
    ts: "2026-11-02T10:00:00.000Z",
    house: "work",
    pet: "sibling",
    event: { kind: "turn-finished", text: `Hi!\n\nSecond paragraph \u001b[31m${"x".repeat(400)}` },
  });
  expect(line).toMatch(/^\d\d:\d\d:\d\d PET   work\/sibling answer: Hi! Second paragraph \\x1b\[31mx+…$/);
  expect(line.length).toBeLessThan(350);
});

test("tool names are cut to one line too, and bidi or zero-width characters show as escapes", () => {
  const line = formatEvent({
    type: "agent",
    ts: "2026-11-02T10:00:00.000Z",
    house: "work",
    pet: "sibling",
    event: { kind: "tool-started", tool: `Bash\n10:00:00 PET   work/other${"x".repeat(400)}`, summary: "ls \u202egnp.exe\u200b" },
  });
  expect(line).not.toMatch(/[\n\u202e\u200b]/);
  expect(line).toContain("tool Bash 10:00:00 PET");
  expect(line).toContain("ls \\u{202e}gnp.exe\\u{200b}");
  expect(line.length).toBeLessThan(400);
});
