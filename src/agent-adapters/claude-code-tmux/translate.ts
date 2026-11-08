import { createHash } from "node:crypto";
import type { AgentEvent } from "../../core/agent-events";
import { actionOf, short as cut } from "./actions";

// Claude Code hook payloads → agent-neutral events. Payload shapes: test/agent-adapters/fixtures/.
// Unknown hooks and malformed payloads give no events.
//
// Dialogs open on PermissionRequest and Elicitation, and already on PreToolUse of the tools that always ask
// (it is synchronous, so it arrives before the dialog is drawn). They close on a new prompt, a new session, the
// end of the turn, or a tool of the main thread finishing; subagents (`agent_id`) never close them. A dialog
// dismissed with Esc fires no hook: Delivery then looks at the screen.
//
// A turn is named by `prompt_id`, which every hook of it carries. Subagents' tool hooks carry `agent_id`; their text never comes.

type Payload = Record<string, unknown>;

/** A string field as text; a lone surrogate (a cut emoji) becomes U+FFFD. */
const text = (value: unknown): string => (typeof value === "string" ? value.toWellFormed() : "");
const record = (value: unknown): Payload => (value && typeof value === "object" ? (value as Payload) : {});
/** At most `max` characters (graphemes: an emoji is never cut in half). */
const short = (value: string, max = 120) => cut(value, max);

/** SessionStart sources whose session goes on in the same process. */
const CONTINUES = ["resume", "clear", "compact"];

export const DIALOG_TOOLS = ["AskUserQuestion", "ExitPlanMode"];

/** JSON with object keys sorted: the same input gives the same text, whatever order claude wrote it in. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Payload)[key])}`).join(",")}}`
      : JSON.stringify(value) ?? "null";

/**
 * A call's fingerprint, by its tool and input: PermissionRequest has no tool_use_id, so this is how a dialog finds
 * the call it is about (PreToolUse and PermissionRequest carry the same input).
 */
export const fingerprint = (tool: string, input: Payload): string => createHash("sha256").update(`${tool}\n${canonical(input)}`).digest("hex").slice(0, 16);
const CLOSED: AgentEvent = { kind: "dialog-closed" };

function dialogFor(tool: string, input: Payload): AgentEvent {
  const call = { input: fingerprint(tool, input) };
  if (tool === "AskUserQuestion") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    return { kind: "dialog-opened", dialog: "question", summary: short(questions.map((q) => text(record(q).question)).join(" / ")), ...call };
  }
  if (tool === "ExitPlanMode") {
    const firstLine = text(input.plan).split("\n").find((line) => line.trim()) ?? "";
    return { kind: "dialog-opened", dialog: "plan", summary: short(firstLine.replace(/^#+\s*/, "")), ...call };
  }
  return { kind: "dialog-opened", dialog: "permission", summary: short(`${tool}: ${actionOf(tool, input).summary}`), ...call };
}

/** The fields given, without those that are empty. */
const present = <T extends Record<string, unknown>>(fields: T): Partial<T> =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== "")) as Partial<T>;

export function translateHook(payload: unknown): AgentEvent[] {
  const hook = record(payload);
  const tool = text(hook.tool_name);
  const input = record(hook.tool_input);
  const mainThread = !text(hook.agent_id);
  const turn = present({ turn: text(hook.prompt_id) });
  const call = present({ ...turn, call: text(hook.tool_use_id), agent: text(hook.agent_id) });
  const ms = typeof hook.duration_ms === "number" && hook.duration_ms >= 0 ? { ms: hook.duration_ms } : {};
  switch (hook.hook_event_name) {
    case "SessionStart": {
      const continues = CONTINUES.includes(text(hook.source)) ? { continues: true as const } : {};
      return [CLOSED, { kind: "session-started", ...(text(hook.model) ? { model: text(hook.model) } : {}), ...continues }];
    }
    case "UserPromptSubmit":
      return [CLOSED, { kind: "prompt-accepted", text: text(hook.prompt), ...turn }];
    case "PreToolUse": {

      const { action, summary, internal } = actionOf(tool, input);
      const started: AgentEvent = { kind: "tool-started", tool, summary, action, ...call, ...(internal ? { internal: true as const } : {}), input: fingerprint(tool, input) };
      return DIALOG_TOOLS.includes(tool) ? [started, dialogFor(tool, input)] : [started];
    }
    case "PostToolUse":
      return [...(mainThread ? [CLOSED] : []), { kind: "tool-finished", tool, ...call, ...ms }];
    case "PostToolUseFailure":
      return [...(mainThread ? [CLOSED] : []), { kind: "tool-finished", tool, ...call, ...ms, failed: true }];
    case "PermissionRequest":
      return [dialogFor(tool, input)];
    case "PermissionDenied": {
      // Native auto-mode denial, including classifier unavailability/no-verdict denials.
      // No equivalent approved/start hook exists in pinned Claude 2.1.296: a successful
      // tool might instead have passed a rule or the read-only check. Never infer approval.
      // The raw reason can quote private input; only the native outcome reaches the UI.
      const id = text(hook.tool_use_id);
      if (!id || !tool) return [];
      return [{ kind: "tool-review", review: `claude-auto:${id}`, ...call, status: "denied", scope: "action" }];
    }
    case "Elicitation":
      return [{ kind: "dialog-opened", dialog: "form", summary: short(`${text(hook.mcp_server_name)}: ${text(hook.message)}`) }];
    case "Notification": {
      // A permission prompt: one that waits on its PermissionRequest hook is a dialog already (opening it again
      // changes nothing); one claude asks without the hook is a dialog only the terminal can answer.
      const prompt = hook.notification_type === "permission_prompt" ? [{ kind: "dialog-opened", dialog: "unknown", summary: short(text(hook.message)) } as const] : [];
      return [...prompt, { kind: "notification", text: text(hook.message) }];
    }
    case "Stop":
      return [CLOSED, { kind: "turn-finished", text: text(hook.last_assistant_message), ...turn }];
    case "StopFailure": // instead of Stop, when the turn ends in an API error
      return [CLOSED, { kind: "turn-failed", error: short(text(hook.error) || "unknown"), ...turn }];
    default:
      return [];
  }
}
