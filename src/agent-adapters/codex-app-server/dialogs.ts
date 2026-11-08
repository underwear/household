import { DIALOG_LIMITS, type DialogAnswer, type DialogQuestion } from "../../core/dialog";

export const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
export const text = (value: unknown): string => typeof value === "string" ? value : "";
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** App-server requests forwarded intact by the in-container bridge. */
export function askOf(payload: unknown): DialogQuestion | undefined {
  const packet = record(payload);
  const params = record(packet.params);
  if (packet.id === undefined) return undefined;
  if (packet.method === "item/commandExecution/requestApproval") {
    return { kind: "permission", tool: "command", detail: text(params.command) || "Run a command", ...(params.reason ? { about: text(params.reason) } : {}), input: text(params.itemId) };
  }
  if (packet.method === "item/fileChange/requestApproval") {
    return { kind: "permission", tool: "file changes", detail: text(params.grantRoot) || text(params.reason) || "Apply file changes", input: text(params.itemId) };
  }
  if (packet.method === "item/permissions/requestApproval") {
    const permissions = record(params.permissions), fs = record(permissions.fileSystem);
    const details = [record(permissions.network).enabled === true ? "network access" : "",
      ...list(fs.read).map(path => `read ${text(path)}`), ...list(fs.write).map(path => `write ${text(path)}`),
      ...list(fs.entries).map(entry => { const e = record(entry); return `${text(e.access)} ${JSON.stringify(e.path)}`; })].filter(Boolean);
    return { kind: "permission", tool: "additional permissions", detail: `For this turn: ${details.join("; ") || "additional sandbox permissions"}`, ...(params.reason ? { about: text(params.reason) } : {}), input: text(params.itemId) };
  }
  if (!["item/tool/requestUserInput", "tool/requestUserInput"].includes(packet.method)) return undefined;
  const questions = list(params.questions).map(record);
  const valid = questions.length > 0 && questions.length <= DIALOG_LIMITS.questions && questions.every(q =>
    text(q.id) && !q.isSecret && text(q.question).trim() && text(q.question).length <= DIALOG_LIMITS.text &&
    list(q.options).length > 0 && list(q.options).length <= DIALOG_LIMITS.options && list(q.options).every(option => {
      const o = record(option);
      return text(o.label).trim() && text(o.label).length <= DIALOG_LIMITS.label && text(o.description).length <= DIALOG_LIMITS.description;
    }));
  if (!valid || new Set(questions.map(q => q.id)).size !== questions.length) return undefined;
  return { kind: "questions", input: text(params.itemId), questions: questions.map(q => ({ text: q.question, multiSelect: false,
    options: list(q.options).map(option => { const o = record(option); return { label: o.label, ...(o.description ? { description: o.description } : {}) }; }),
  })) };
}

/** Answers grant only this call, never a session, execpolicy or network amendment. */
export function answerFor(payload: unknown, answer: DialogAnswer): object {
  const packet = record(payload);
  const params = record(packet.params);
  if (packet.method === "item/permissions/requestApproval") {
    const requested = record(params.permissions);
    const allow = answer.kind === "allow" || answer.kind === "approve";
    return { permissions: allow ? { ...(requested.network ? { network: requested.network } : {}), ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}) } : {}, scope: "turn" };
  }
  if (!["item/tool/requestUserInput", "tool/requestUserInput"].includes(packet.method)) return { decision: answer.kind === "allow" || answer.kind === "approve" ? "accept" : answer.kind === "stopped" ? "cancel" : "decline" };
  const answers = answer.kind === "answers" || answer.kind === "timeout" ? answer.answers : [];
  return { answers: Object.fromEntries(list(params.questions).map((q, i) => {
    const given = answers[i];
    return [text(record(q).id), { answers: given ? "text" in given ? [given.text] : given.chosen : ["No answer was provided. Continue where possible without it."] }];
  })) };
}
