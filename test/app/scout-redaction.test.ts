import { expect, test } from "bun:test";
import { askRedactedDialog, redactAgentEvent } from "../../src/app/scout-redaction";
import { answerFor } from "../../src/agent-adapters/claude-code-tmux/dialogs";
import type { DialogQuestion } from "../../src/core/dialog";
const redact = (text: string) => text.replaceAll("secret-a", "[masked]").replaceAll("secret-b", "[masked]");

test("normalized redaction preserves protocol identifiers even when a credential overlaps them", () => {
  expect(redactAgentEvent({ kind: "tool-started", tool: "Read", summary: "secret-a", input: "secret-a", call: "secret-a", turn: "secret-a", agent: "secret-a" }, redact)).toEqual({ kind: "tool-started", tool: "Read", summary: "[masked]", input: "secret-a", call: "secret-a", turn: "secret-a", agent: "secret-a" });
  expect(redactAgentEvent({ kind: "session-started", model: "secret-a" }, redact)).toEqual({ kind: "session-started", model: "secret-a" });
});

test("masked question labels are distinct and map back into the original native tool input", async () => {
  const dialog: DialogQuestion = { kind: "questions", input: "secret-a", questions: [{ text: "Use secret-a?", multiSelect: false, options: [{ label: "secret-a", description: "First secret-a" }, { label: "secret-b" }] }] };
  const answer = await askRedactedDialog(dialog, redact, async shown => {
    expect(shown.input).toBe("secret-a");
    if (shown.kind !== "questions") throw new Error("Expected questions");
    expect(shown.questions[0]!.text).toBe("Use [masked]?");
    expect(shown.questions[0]!.options[0]!.label).not.toBe(shown.questions[0]!.options[1]!.label);
    return { kind: "answers", answers: [{ chosen: [shown.questions[0]!.options[1]!.label] }] };
  });
  expect(answer).toEqual({ kind: "answers", answers: [{ chosen: ["secret-b"] }] });
  const payload = { tool_input: { questions: [{ question: "Use secret-a?", options: [{ label: "secret-a" }, { label: "secret-b" }] }] } };
  const native = answerFor(payload, answer!);
  expect(native).toMatchObject({ hookSpecificOutput: { decision: { updatedInput: { ...payload.tool_input, answers: { "Use secret-a?": "secret-b" } } } } });
});

test("permission and plan presentation preserve fingerprints and do not rewrite the approved plan", async () => {
  const plan: DialogQuestion = { kind: "plan", input: "secret-a", plan: "Deploy with secret-a" };
  const answer = await askRedactedDialog(plan, redact, async shown => { expect(shown).toEqual({ kind: "plan", input: "secret-a", plan: "Deploy with [masked]" }); return { kind: "approve" }; });
  expect(answerFor({ tool_input: { plan: plan.plan } }, answer!)).toMatchObject({ hookSpecificOutput: { decision: { updatedInput: { plan: "Deploy with secret-a" } } } });
  await askRedactedDialog({ kind: "permission", input: "secret-a", tool: "Bash", detail: "secret-a", about: "secret-b" }, redact, async shown => { expect(shown).toEqual({ kind: "permission", input: "secret-a", tool: "Bash", detail: "[masked]", about: "[masked]" }); return { kind: "allow" }; });
});

test("agent route redacts reply text but never channel IDs or native dialog payloads", async () => {
  const { agentRoutes } = await import("../../src/app/agent-routes");
  let native: unknown; let replyArgs: unknown;
  const route = agentRoutes({ onPayload: async (_h, _p, payload) => { native = payload; return {}; } }, {
    reply: async (...args) => { replyArgs = args; return { id: "m1", channel: "c1" }; }, react: async () => ({ id: "m1", reaction: null }),
  }, { find: async () => ({ messages: [], more: false }) } as never, undefined, undefined, undefined, undefined, [], () => false, {
    allow: () => true,
    redact: (_caller, payload) => JSON.parse(JSON.stringify(payload).replaceAll("c1", "[masked]")),
  });
  const caller = { house: "work", pet: "scout-1" };
  await route(caller, new Request("http://x/mcp", { method: "POST", body: JSON.stringify({ id: 1, method: "tools/call", params: { name: "reply", arguments: { text: "Value c1", channel: "c1" } } }) }));
  expect(replyArgs).toEqual(["work", "scout-1", "Value [masked]", undefined, "c1", undefined]);
  const payload = { hook_event_name: "PermissionRequest", tool_input: { plan: "Deploy c1" }, requestId: "c1" };
  await route(caller, new Request("http://x/events", { method: "POST", body: JSON.stringify(payload) }));
  expect(native).toEqual(payload);
});
