/**
 * A dialog that holds the agent until its person answers, in agent-neutral terms: the adapter reads it out of
 * its agent's own signal (`AgentAdapter.ask`) and turns the answer back into what its agent takes (`answer`).
 * `questions`: one or more questions, each with options (`multiSelect`: any number of them); `plan`: a plan
 * of work to approve; `permission`: may it go on with a tool call (`tool`, on `detail`; `about`: what for, in
 * the agent's words, when it says). `input`: the fingerprint of the tool call it is about (`AgentEvent`'s), when
 * the adapter can tell.
 */
export type DialogQuestion = (
  | { kind: "questions"; questions: Question[] }
  | { kind: "plan"; plan: string }
  | { kind: "permission"; tool: string; detail: string; about?: string }
) & { input?: string };

export interface Question {
  text: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

/** One question's answer: the labels of the options chosen, or the person's own words instead. */
export type QuestionAnswer = { chosen: string[] } | { text: string };

/**
 * `answers`: one per question, in order. `approve` / `revise`: a plan, as it is or with what to change.
 * `allow` / `deny`: a permission; `unanswered`: nobody answered it in `waitedMs`, so Household refused it.
 * `stopped`: the person stopped the agent while it waited (it is refused, and the agent's turn ends).
 * `timeout`: nobody answered in time (`answers`: those given by then, per question); the agent should carry on.
 * `refused`: Household could not put it to the person (`message` says why, for the agent).
 */
export type DialogAnswer =
  | { kind: "answers"; answers: QuestionAnswer[] }
  | { kind: "approve" }
  | { kind: "revise"; text: string }
  | { kind: "allow" }
  | { kind: "deny" }
  | { kind: "unanswered"; waitedMs: number }
  | { kind: "stopped" }
  | { kind: "timeout"; answers: (QuestionAnswer | undefined)[] }
  | { kind: "refused"; message: string };

/**
 * The largest dialog Household puts to the person (Claude's own are smaller); a larger one stays in the agent's
 * session. Distinct question texts, characters per text, per option label and description, per plan.
 */
export const DIALOG_LIMITS = { questions: 4, options: 6, text: 1000, label: 64, description: 300, plan: 16_384 };
