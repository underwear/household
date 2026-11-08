import { expect, test } from "bun:test";
import { readAnthropicAllowance } from "../../src/agent-adapters/claude-code-tmux/allowance";
import { describeAllowance, spentWindow } from "../../src/core/allowance";

// As api.anthropic.com answered a `claude setup-token` request on 2026-11-08 (values as seen, the 7d window near its end).
const SUBSCRIPTION = {
  "anthropic-ratelimit-unified-representative-claim": "seven_day",
  "anthropic-ratelimit-unified-7d-reset": "1794236400",
  "anthropic-ratelimit-unified-7d-status": "allowed_warning",
  "anthropic-ratelimit-unified-7d-utilization": "0.99",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.01",
  "anthropic-ratelimit-unified-5h-reset": "1794147600",
  "anthropic-ratelimit-unified-overage-status": "allowed",
  "anthropic-ratelimit-unified-overage-utilization": "0.0",
  "anthropic-ratelimit-unified-status": "allowed_warning",
  "request-id": "req_011CgqTBxeiikR73JkGeuJUi",
};

test("a subscription's answer: each window with its utilization, reset and status, and the account's overage", () => {
  const allowance = readAnthropicAllowance(new Headers(SUBSCRIPTION), 1_794_000_000_000)!;
  expect(allowance).toEqual({
    at: 1_794_000_000_000,
    windows: [
      { name: "5h", utilization: 0.01, resetsAt: 1_794_147_600_000, status: "allowed" },
      { name: "7d", utilization: 0.99, resetsAt: 1_794_236_400_000, status: "allowed_warning" },
    ],
    overage: { status: "allowed", utilization: 0 },
  });
  expect(describeAllowance(allowance)).toBe("5h 1% · 7d 99%");
  expect(spentWindow(allowance, 1_794_000_000_000)).toBeUndefined();
  const spent = readAnthropicAllowance(new Headers({ ...SUBSCRIPTION, "anthropic-ratelimit-unified-7d-utilization": "1.0" }))!;
  expect(spentWindow(spent, 1_794_000_000_000)).toMatchObject({ name: "7d" });
  // Over, and the window already started again: nothing is spent.
  expect(spentWindow(spent, 1_794_236_400_001)).toBeUndefined();
});

test("an API key's answer, an error's, or a window without a reset says nothing of an allowance", () => {
  expect(readAnthropicAllowance(new Headers({ "request-id": "req_x", "anthropic-ratelimit-requests-remaining": "49" }))).toBeUndefined();
  expect(readAnthropicAllowance(new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.5" }))).toBeUndefined();
  expect(readAnthropicAllowance(new Headers({ "anthropic-ratelimit-unified-5h-utilization": "abc", "anthropic-ratelimit-unified-5h-reset": "1794147600" }))).toBeUndefined();
  // Overage headers without a window are not an allowance either.
  expect(readAnthropicAllowance(new Headers({ "anthropic-ratelimit-unified-overage-status": "allowed" }))).toBeUndefined();
});
