import type { AgentEvent, ToolAction } from "../../core/agent-events";
import { askOf, record, text } from "./dialogs";

const short = (value: string) => Array.from(value).slice(0, 160).join("");
const closed = { kind: "dialog-closed" } as const;
const REVIEW_ACTION: Record<string, string> = { command: "command", execve: "command", writeStdin: "terminal input", applyPatch: "file changes", networkAccess: "network access", mcpToolCall: "tool call", requestPermissions: "extra permissions" };
/** Never copy the raw reviewer rationale or action input into progress. */
function reviewEvents(packet: Record<string, any>, p: Record<string, any>): AgentEvent[] | undefined {
  if (!["item/autoApprovalReview/started", "item/autoApprovalReview/completed"].includes(packet.method)) return undefined;
  if (!text(p.reviewId)) return [];
  const status = packet.method.endsWith("/started") ? "inProgress" : text(record(p.review).status);
  if (!["inProgress", "approved", "denied", "timedOut", "aborted"].includes(status)) return [];
  // Native targetItemId identifies the reviewed item. Network reviews deliberately have no target.
  // Do not guess from the last command, action input, or the review id itself.
  return [{ kind: "tool-review", review: text(p.reviewId),
    ...(text(p.targetItemId) ? { call: text(p.targetItemId) } : {}),
    ...(text(p.turnId) ? { turn: text(p.turnId) } : {}),
    status: status as Extract<AgentEvent, { kind: "tool-review" }>["status"],
    scope: REVIEW_ACTION[text(record(p.action).type)] ?? "action" }];
}

function toolOf(item: Record<string, any>): { tool: string; summary: string; action: ToolAction; internal?: true } | undefined {
  switch (item.type) {
    case "commandExecution": {
      const first = record(item.commandActions?.[0]);
      const kind = first.type === "read" ? "read" : first.type === "search" || first.type === "listFiles" ? "search" : "run";
      return { tool: "command", summary: short(text(item.command)), action: { kind, target: short(text(first.path) || text(first.query) || text(item.command)) } };
    }
    case "fileChange": {
      const paths = Array.isArray(item.changes) ? item.changes.map((c: unknown) => text(record(c).path)).join(", ") : "files";
      return { tool: "file changes", summary: short(paths), action: { kind: "edit", target: short(paths) } };
    }
    case "mcpToolCall": return { tool: `${text(item.server)}.${text(item.tool)}`, summary: short(text(item.tool)), action: { kind: "other", target: text(item.tool) }, ...(item.server === "household" ? { internal: true as const } : {}) };
    case "dynamicToolCall": return { tool: text(item.tool), summary: short(text(item.tool)), action: { kind: "other", target: text(item.tool) } };
    case "webSearch": return { tool: "web search", summary: short(text(item.query)), action: { kind: "search", target: short(text(item.query)) } };
    case "collabAgentToolCall": return { tool: text(item.tool), summary: short(text(item.prompt)), action: { kind: "delegate", target: text(item.model) } };
    default: return undefined;
  }
}

/** Only selected app-server events cross the adapter boundary. */
export function translatePacket(payload: unknown): AgentEvent[] {
  const packet = record(payload), p = record(packet.params), item = record(p.item);
  const review = reviewEvents(packet, p);
  if (review) return review;
  const turn = text(p.turnId) ? { turn: text(p.turnId) } : {};
  const dialog = askOf(payload);
  if (dialog) return [{ kind: "dialog-opened", dialog: dialog.kind === "questions" ? "question" : "permission", summary: dialog.kind === "questions" ? short(dialog.questions.map(q => q.text).join(" / ")) : short(dialog.kind === "permission" ? dialog.detail : dialog.plan), ...(dialog.input ? { input: dialog.input } : {}) }];
  switch (packet.method) {
    case "household/sessionStarted": return [closed, { kind: "session-started", model: text(p.model), ...(p.continues ? { continues: true as const } : {}) }];
    case "item/started": {
      if (item.type === "userMessage") return [closed, { kind: "prompt-accepted", text: (Array.isArray(item.content) ? item.content : []).filter((part: any) => part.type === "text").map((part: any) => text(part.text)).join("\n"), ...turn }];
      const tool = toolOf(item);
      return tool ? [{ kind: "tool-started", ...tool, ...turn, call: text(item.id), input: text(item.id) }] : [];
    }
    case "thread/compacted": return [{ kind: "session-started", continues: true }];
    case "item/completed": {
      if (item.type === "contextCompaction") return [{ kind: "session-started", continues: true }];
      const tool = toolOf(item);
      return tool ? [closed, { kind: "tool-finished", tool: tool.tool, ...turn, call: text(item.id), ...(typeof item.durationMs === "number" ? { ms: item.durationMs } : {}), ...((item.exitCode !== undefined && item.exitCode !== null && item.exitCode !== 0) || item.status === "failed" || item.error ? { failed: true } : {}) }] : [];
    }
    case "turn/completed": {
      const completed = record(p.turn), id = text(completed.id);
      return completed.status === "failed" ? [closed, { kind: "turn-failed", turn: id, error: short(text(record(completed.error).message) || "Codex turn failed") }] : [closed, { kind: "turn-finished", turn: id, text: text(p.lastMessage) }];
    }
    case "household/failed": return [closed, { kind: "turn-failed", scope: "session", error: "Codex bridge disconnected" }];
    default: return [];
  }
}
