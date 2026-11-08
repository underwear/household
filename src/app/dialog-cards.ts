import type { Choices } from "../core/channel";
import type { DialogQuestion, Question } from "../core/dialog";
import { oneLine } from "../core/excerpt";

// What a pet's dialog looks like in the chat: one card (a notice) per question, or one for a plan. The texts
// are for the person, in English; the choices are neutral rows the channel draws. Every card fits one message
// (DIALOG_LIMITS keep a question's small; a plan is cut), so none of its text can pass for another notice.

const DONE = "Done";
const APPROVE = "✅ Approve";
/** A permission's choices, in this order: the first allows. */
export const PERMISSION_CHOICES = ["Yes", "No"];
/** How much of a plan its card shows. */
const PLAN_SHOWN = 3000;

/** Text in one line, cut to `max`, in "quotes". */
export const quote = (text: string, max = 60) => `"${oneLine(text, max)}"`;

/** Question `index` of `count` that pet `title` asks, with its options and how to answer. */
function questionCard(title: string, question: Question, index: number, count: number): string {
  const options = question.options.map(({ label, description }) => (description ? `• ${label} — ${description}` : `• ${label}`));
  const how = question.multiSelect
    ? `Tick what fits and press "${DONE}", or answer in text.`
    : "Answer with a button or in text.";
  return [`${title} asks${count > 1 ? ` (${index + 1} of ${count})` : ""}:`, "", question.text, "", ...options, "", how].join("\n");
}

/** One option per row; a multi-select marks the chosen ones with ✓ and ends with "Done". */
export function questionChoices(question: Question, marked: ReadonlySet<number>): Choices {
  const rows = question.options.map(({ label }, i) => [question.multiSelect && marked.has(i) ? `✓ ${label}` : label]);
  return question.multiSelect ? [...rows, [DONE]] : rows;
}

function planCard(title: string, plan: string): string {
  const shown = plan.length > PLAN_SHOWN ? `${plan.slice(0, PLAN_SHOWN).trimEnd()}\n…\n(the rest is in \`house pet attach\`)` : plan.trim();
  return `${title} asks you to approve a plan:\n\n${shown}\n\nApprove with the button or write what to change.`;
}

/** What the agent wants to do, in one line (what for, when it says), and how long Household waits before it refuses. */
function permissionCard(title: string, { tool, detail, about }: Extract<DialogQuestion, { kind: "permission" }>, waitMs: number): string {
  const what = oneLine(`${tool}: ${detail}`, 300);
  return [`${title} asks for permission (an action inside its VM):`, "", what, ...(about ? [`(${oneLine(about, 200)})`] : []), "", `No answer in ${Math.round(waitMs / 1000)} s means no.`].join("\n");
}

/** The cards of a dialog, in order: the plan's (its only choice approves it), a permission's, or one per question (`waitMs`: how long it waits). */
export function cardsFor(title: string, dialog: DialogQuestion, waitMs = 0): { text: string; choices: Choices }[] {
  if (dialog.kind === "plan") return [{ text: planCard(title, dialog.plan), choices: [[APPROVE]] }];
  if (dialog.kind === "permission") return [{ text: permissionCard(title, dialog, waitMs), choices: [PERMISSION_CHOICES] }];
  return dialog.questions.map((question, i, all) => ({ text: questionCard(title, question, i, all.length), choices: questionChoices(question, new Set()) }));
}
