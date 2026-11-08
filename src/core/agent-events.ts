/**
 * What a tool call does: reads, writes or edits a file, runs a program, searches, fetches a page, gives work to
 * another agent, asks the person, proposes a plan, or something else. `target`: what it is on, short (a file, a
 * program, a pattern, a host; for `other`, the tool's name in words); `says`: what it is for in the agent's own
 * words, when it says.
 */
export interface ToolAction {
  kind: "read" | "write" | "edit" | "run" | "search" | "fetch" | "delegate" | "ask" | "plan" | "other";
  target?: string;
  says?: string;
}

/** A dialog that holds the agent until a person answers it in the agent's session (`unknown`: only seen on screen). */
export type DialogKind = "permission" | "question" | "plan" | "form" | "unknown";

/**
 * What a pet's agent did, in agent-neutral terms. Adapters translate their agent's own signals (Claude Code
 * hooks, …) into these; nothing downstream sees agent-specific payloads. Adapters say when a dialog closes
 * (`dialog-closed`) wherever it may have; one that changes nothing is ignored.
 *
 * `turn`: the agent's id of the turn an event belongs to (from the prompt it took to its end), when it says; the
 * same on every event of that turn. `agent`: the id of a subagent the event comes from; none for the main thread.
 * `input`: a fingerprint of a tool call's tool and input, the same on its start and on a dialog asking about it
 * (which carries no call id), when the adapter can tell.
 */
export type AgentEvent =
  /**
   * `model`: the model the session runs, as the agent names it, when it says. `continues`: the agent goes on in
   * the same process (it compacted its context, was cleared or resumed): nothing it was doing is lost.
   */
  | { kind: "session-started"; model?: string; continues?: true }
  | { kind: "prompt-accepted"; text: string; turn?: string }
  /**
   * `call`: the agent's id of this call, the same on its `tool-finished`. `action`: what the call does, in
   * neutral terms (Household says it in the chat's words). `internal`: the agent's own plumbing (finding its tools,
   * its task list, Household's tools: their result is in the chat), no work to show. `summary`: what it runs on (a
   * command, a path, a URL).
   */
  | { kind: "tool-started"; tool: string; summary: string; action?: ToolAction; internal?: true; turn?: string; call?: string; agent?: string; input?: string }
  /** `ms`: how long the call took, when the agent says; `failed`: it ended in an error. */
  | { kind: "tool-finished"; tool: string; turn?: string; call?: string; agent?: string; ms?: number; failed?: boolean }
  /** A native automatic review decision, correlated only by its exact target call id when available. */
  | { kind: "tool-review"; review: string; call?: string; turn?: string; agent?: string; status: "inProgress" | "approved" | "denied" | "timedOut" | "aborted"; scope?: string }
  | { kind: "dialog-opened"; dialog: DialogKind; summary: string; input?: string }
  | { kind: "dialog-closed" }
  | { kind: "notification"; text: string; audience?: "chat" }
  /** `text`: the turn's last message. */
  | { kind: "turn-finished"; text: string; turn?: string }
  /** scope=session: the entire connection/session failed, including prompts awaiting acceptance.
   * The turn ended in an error of the agent's (its model's service failing, …): it will not finish. */
  | { kind: "turn-failed"; error: string; turn?: string; scope?: "session" };

/** What a turn's progress is made of: the agent's steps. */
export type TurnProgress = Extract<AgentEvent, { kind: "tool-started" | "tool-finished" | "tool-review" }>;
