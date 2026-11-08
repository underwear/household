import { DIALOG_LIMITS, type DialogAnswer, type DialogQuestion, type Question } from "../../core/dialog";
import { actionOf } from "./actions";
import { DIALOG_TOOLS, fingerprint } from "./translate";

// Claude Code's dialogs as Household answers them: at the PermissionRequest hook, which fires for
// AskUserQuestion and ExitPlanMode in bypass mode too, and for the permission dialogs of claude's own safety
// checks (its ask path runs PermissionRequest hooks and takes their allow/deny; read in 2.1.296, not yet seen
// live), and waits for the hook's answer (tmux experiment, RESULTS.md #7–17). An answer typed in the terminal meanwhile wins: claude 2.1.296 then leaves the hook running
// and ignores its answer (E2E), so Household learns of it from the dialog closing (PostToolUse).

type Payload = Record<string, unknown>;

const record = (value: unknown): Payload => (value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const { questions: maxQuestions, options: maxOptions, text: maxText, label: maxLabel, description: maxDescription, plan: maxPlan } = DIALOG_LIMITS;
const within = (value: string, max: number) => value.trim() !== "" && value.length <= max;

/** One question, if it is within Household's limits: options with labels, every text short enough. */
function question(value: unknown): Question | undefined {
  const asked = record(value);
  const options = list(asked.options).map(record);
  const fits = options.every((option) => within(text(option.label), maxLabel) && text(option.description).length <= maxDescription);
  if (!within(text(asked.question), maxText) || options.length === 0 || options.length > maxOptions || !fits) return undefined;
  return {
    text: text(asked.question),
    options: options.map((option) => ({ label: text(option.label), ...(text(option.description) ? { description: text(option.description) } : {}) })),
    multiSelect: asked.multiSelect === true,
  };
}

/**
 * The dialog of a PermissionRequest: the question or plan of AskUserQuestion or ExitPlanMode (undefined for one
 * over Household's limits or with two questions alike: answers are keyed by question text), or for any other tool
 * a permission to go on with it. Undefined for any other hook.
 */
export function askOf(payload: unknown): DialogQuestion | undefined {
  const hook = record(payload);
  if (hook.hook_event_name !== "PermissionRequest") return undefined;
  const input = record(hook.tool_input);
  const call = { input: fingerprint(text(hook.tool_name), input) };
  // Any other tool: claude asks whether to go on (in bypass mode, its own safety checks: a dangerous rm, …).
  // Its own timer for them is off (CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT): Household's is the only one.
  if (!DIALOG_TOOLS.includes(text(hook.tool_name))) {
    const tool = text(hook.tool_name) || "tool";
    const { action, summary } = actionOf(tool, input);
    return { kind: "permission", tool, detail: summary, ...(action.says ? { about: action.says } : {}), ...call };
  }
  if (hook.tool_name === "ExitPlanMode") return within(text(input.plan), maxPlan) ? { kind: "plan", plan: text(input.plan), ...call } : undefined;
  if (hook.tool_name !== "AskUserQuestion") return undefined;
  const asked = list(input.questions);
  const questions = asked.map(question).filter((one) => one !== undefined);
  const distinct = new Set(questions.map((one) => one.text)).size === questions.length;
  if (asked.length === 0 || asked.length > maxQuestions || questions.length < asked.length || !distinct) return undefined;
  return { kind: "questions", questions, ...call };
}

/**
 * The hook's answer. Allow always carries `updatedInput` with the original input (a plain allow of a plan is
 * ignored); for questions it adds `answers`: question text → the label chosen, several as "A, B", or the
 * person's own words. A plan to revise, and a dialog nobody answered, are denied with a message for claude.
 */
export function answerFor(payload: unknown, answer: DialogAnswer): object {
  const input = record(record(payload).tool_input);
  const decide = (decision: object) => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  switch (answer.kind) {
    case "answers": {
      const asked = list(input.questions).map((value) => text(record(value).question));
      const given = answer.answers.map((one) => ("text" in one ? one.text : one.chosen.join(", ")));
      return decide({ behavior: "allow", updatedInput: { ...input, answers: Object.fromEntries(asked.map((q, i) => [q, given[i] ?? ""])) } });
    }
    case "approve":
      return decide({ behavior: "allow", updatedInput: input });
    // No updatedInput: with one, claude checks the call again, and its safety check would ask again.
    case "allow":
      return decide({ behavior: "allow" });
    case "deny":
      return decide({ behavior: "deny", message: "Your human said no to this. Do not do it; find another way, or ask them with the reply tool." });
    // The person stopped the agent while it waited: refused, and its turn interrupted (claude 2.1.296 takes
    // `interrupt` on a PermissionRequest deny).
    case "stopped":
      return decide({ behavior: "deny", message: "Your human stopped you.", interrupt: true });
    case "unanswered": {
      const seconds = Math.round(answer.waitedMs / 1000);
      return decide({ behavior: "deny", message: `No answer from your human in ${seconds} s, so this is not allowed for now. They did not say no: ask them with the reply tool, or find another way.` });
    }
    case "revise":
      return decide({ behavior: "deny", message: `Your human asks you to revise the plan: ${answer.text}` });
    case "refused":
      return decide({ behavior: "deny", message: answer.message });
    case "timeout": {
      const asked = list(input.questions).map((value) => text(record(value).question));
      const given = answer.answers.flatMap((one, i) => (one ? [`"${asked[i]}": "${"text" in one ? one.text : one.chosen.join(", ")}"`] : []));
      const partly = given.length > 0 ? ` They answered only some questions: ${given.join("; ")}.` : "";
      return decide({
        behavior: "deny",
        message: `Your human did not answer in time.${partly} Carry on without the answer where you can, or ask again later with the reply tool.`,
      });
    }
  }
}
