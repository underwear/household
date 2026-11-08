import type { AgentEvent } from "../core/agent-events";
import type { DialogAnswer, DialogQuestion, QuestionAnswer } from "../core/dialog";

/** Redact only human-visible fields. Protocol IDs and discriminants are never credential text. */
export function redactAgentEvent(event: AgentEvent, redact: (text: string) => string): AgentEvent {
  switch (event.kind) {
    case "prompt-accepted":
    case "turn-finished":
    case "notification": return { ...event, text: redact(event.text) };
    case "turn-failed": return { ...event, error: redact(event.error) };
    case "dialog-opened": return { ...event, summary: redact(event.summary) };
    case "tool-started": return { ...event, summary: redact(event.summary), ...(event.action ? { action: { ...event.action, ...(event.action.target ? { target: redact(event.action.target) } : {}), ...(event.action.says ? { says: redact(event.action.says) } : {}) } } : {}) };
    default: return event;
  }
}

/**
 * Show masked questions without changing the native tool call. Selection labels are translated back by
 * index; labels changed by masking get a unique suffix, so two secrets cannot collapse into one choice.
 */
export async function askRedactedDialog(dialog: DialogQuestion, redact: (text: string) => string, ask: (shown: DialogQuestion) => Promise<DialogAnswer | undefined>): Promise<DialogAnswer | undefined> {
  if (dialog.kind === "permission") return ask({ ...dialog, detail: redact(dialog.detail), ...(dialog.about ? { about: redact(dialog.about) } : {}) });
  if (dialog.kind === "plan") return ask({ ...dialog, plan: redact(dialog.plan) });
  const shown: DialogQuestion = { ...dialog, questions: dialog.questions.map(question => {
    const changed = question.options.some(option => redact(option.label) !== option.label);
    return { ...question, text: redact(question.text), options: question.options.map((option, index) => ({ ...option, label: changed ? `${redact(option.label).slice(0, 48)} (option ${index + 1})` : option.label, ...(option.description ? { description: redact(option.description) } : {}) })) };
  }) };
  const answer = await ask(shown);
  const original = (value: QuestionAnswer | undefined, index: number): QuestionAnswer | undefined => {
    if (!value || "text" in value) return value;
    return { chosen: value.chosen.map(label => {
      const at = shown.questions[index]?.options.findIndex(option => option.label === label) ?? -1;
      return at < 0 ? label : dialog.questions[index]!.options[at]!.label;
    }) };
  };
  if (answer?.kind === "answers") return { ...answer, answers: answer.answers.map((value, index) => original(value, index)!) };
  if (answer?.kind === "timeout") return { ...answer, answers: answer.answers.map(original) };
  return answer;
}
