import { createHash, randomUUID } from "node:crypto";
import { HouseholdError } from "../core/errors";
import { cardText, html } from "../core/card";
import type { PetIdentity } from "../infra/agent-api";
import type { KeyValueStore } from "../infra/sqlite-store";
import type { OwnerCard } from "./chat";
import { GOOGLE_OPERATIONS } from "../infra/google/operations";
import { SLACK_OPERATIONS } from "../infra/slack/operations";
import { MICROSOFT_OPERATIONS } from "../infra/microsoft/operations";
import { MAIL_OPERATIONS } from "../infra/mail/operations";

export type ConnectorProvider = "google" | "slack" | "microsoft" | "mail";
export interface ConnectorWriteView {
  id: string; provider: ConnectorProvider; connection: string; account: string; operation: string;
  params: unknown; state: "pending" | "executing" | "succeeded" | "denied" | "cancelled" | "unknown";
  expiresAt: string; detail?: string;
}
interface Write extends ConnectorWriteView { house: string; pet: string; key: string; fingerprint: string; result?: unknown }
export interface ConnectorWriteApproval {
  ask(caller: PetIdentity, write: ConnectorWriteView, signal: AbortSignal): Promise<"approved" | "denied" | undefined>;
}
const KEY = "house.connectors.writes.v1", USED = "house.connectors.writes.used.v1.";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const view = ({ house, pet, key, fingerprint, result, ...rest }: Write): ConnectorWriteView => structuredClone(rest);

export function connectorWriteCard(write: ConnectorWriteView, now = Date.now()): OwnerCard<"pending" | "approved" | "denied"> {
  const registry: Record<string, { description: string }> = { google: GOOGLE_OPERATIONS, slack: SLACK_OPERATIONS, microsoft: MICROSOFT_OPERATIONS, mail: MAIL_OPERATIONS }[write.provider];
  const action = registry[write.operation]?.description.split(/\.\s/)[0] ?? write.operation;
  const label = (key: string) => {
    const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  const details = Object.entries(write.params as Record<string, unknown>).filter(([, value]) => value !== undefined).map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return `${html(label(key))}: ${["text", "html", "content", "initial_comment"].includes(key) || typeof value === "object" || text.includes("\n") ? `\n<blockquote>${html(text)}</blockquote>` : html(text)}`;
  }).join("\n\n");
  const remaining = Date.parse(write.expiresAt) - now;
  const expiry = remaining <= 0 ? "Expired" : remaining < 60_000 ? "Expires in less than 1 min" : `Expires in ${Math.ceil(remaining / 60_000)} min`;
  const text = cardText({ title: `Approve ${html(write.provider === "mail" ? "mailbox" : write.provider === "microsoft" ? "Microsoft To Do" : write.provider === "google" ? "Google" : "Slack")} change`, facts: [`Account: ${html(write.account)}`, `Action: ${html(action)}`] })
    + `\n\n${details}\n\nApprove applies exactly this change. Deny changes nothing.\n\n${expiry}`;
  return { text, format: "html", start: "pending", view: state => state === "pending" ? { choices: [["Approve change"], ["Deny"]], text } : { outcome: state === "approved" ? "Approved for submission" : "Change denied" }, press: (state, index) => state !== "pending" ? state : index === 0 ? "approved" : index === 1 ? "denied" : state, cancelledText: () => "This approval request is closed. Nothing further can be approved with these buttons." };
}

/** Durable, single-use approvals. No write is retried after a crash or an uncertain result. */
export class ConnectorWrites {
  private jobs = new Map<string, Promise<unknown>>();
  private active = new Map<string, AbortController>();
  private stopped = false;
  constructor(private store: KeyValueStore, private approval?: ConnectorWriteApproval, private now = Date.now, private lifetimeMs = 600_000) {
    const writes = this.read();
    for (const w of writes) {
      if (w.state === "pending") { w.state = "cancelled"; w.detail = "Household restarted before approval."; }
      else if (w.state === "executing") { w.state = "unknown"; w.detail = "Household restarted during the change. Inspect the account before trying again."; }
    }
    store.set(KEY, JSON.stringify(writes));
  }
  private read(): Write[] { return JSON.parse(this.store.get(KEY) ?? "[]"); }
  private put(w: Write) {
    const items = this.read().filter(item => item.id !== w.id); items.push(w);
    const pending = items.filter(item => item.state === "pending" || item.state === "executing");
    const done = items.filter(item => item.state !== "pending" && item.state !== "executing").slice(-100);
    this.store.set(KEY, JSON.stringify([...done, ...pending]));
  }
  private prior(w: Write): unknown {
    if (w.state === "succeeded") return structuredClone(w.result);
    throw new HouseholdError(`Connector change ${w.state} (${w.id}). ${w.detail ?? "Nothing was changed."} Do not retry with a new clientRequestId without reviewing the outcome.`);
  }
  status(caller: PetIdentity, accessible: (provider: ConnectorProvider, connection: string) => boolean, id?: string) {
    return this.read().filter(w => w.house === caller.house && w.pet === caller.pet && (!id || w.id === id) && accessible(w.provider, w.connection)).map(view);
  }
  cancel(caller: PetIdentity, id: string, accessible: (provider: ConnectorProvider, connection: string) => boolean) {
    const w = this.read().find(w => w.id === id && w.house === caller.house && w.pet === caller.pet && accessible(w.provider, w.connection));
    if (!w) throw new HouseholdError("Connector change unavailable to this bot");
    if (w.state !== "pending") return { cancelled: false, state: w.state };
    this.active.get(id)?.abort();
    return { cancelled: true, state: "cancelled" };
  }
  run<T>(input: { caller: PetIdentity; provider: ConnectorProvider; connection: string; account: string; operation: string; params: unknown; review?: unknown; prepare?: (signal: AbortSignal) => Promise<unknown>; requireApproval?: boolean; clientRequestId?: string; signal: AbortSignal; validate: () => void; execute: (signal: AbortSignal) => Promise<T> }): Promise<T> {
    if (this.stopped) throw new HouseholdError("Connector approvals are stopped");
    if (!input.clientRequestId || !/^[A-Za-z0-9._:-]{1,100}$/.test(input.clientRequestId)) throw new HouseholdError("This connection asks for approval. Supply a stable clientRequestId for this intended change; reuse it when checking the same request.");
    input.validate(); input.signal.throwIfAborted();
    const key = digest([input.caller.house, input.caller.pet, input.provider, input.connection, input.clientRequestId]);
    const fingerprint = digest([input.operation, input.params]);
    const prior = this.read().find(w => w.key === key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new HouseholdError("clientRequestId was already used for different parameters");
      return (this.jobs.get(prior.id) ?? Promise.resolve().then(() => this.prior(prior))) as Promise<T>;
    }
    if (this.store.get(USED + key)) throw new HouseholdError("clientRequestId was already used; its history expired. No change was retried.");
    if (this.active.size >= 20) throw new HouseholdError("Too many connector approvals in progress");
    let params = structuredClone(input.review ?? input.params);
    if (Buffer.byteLength(JSON.stringify(params)) > 128 * 1024) {
      if (input.requireApproval !== false) throw new HouseholdError("This change is too large to review in a chat. Split it into smaller changes.");
      params = { note: "Large parameters omitted from automatic-write history." };
    }
    const w: Write = { id: randomUUID(), provider: input.provider, connection: input.connection, account: input.account, operation: input.operation, params, state: "pending", expiresAt: new Date(this.now() + this.lifetimeMs).toISOString(), ...input.caller, key, fingerprint };
    this.store.set(USED + key, fingerprint); this.put(w);
    const controller = new AbortController(); this.active.set(w.id, controller);
    const combined = AbortSignal.any([input.signal, controller.signal]);
    const job = this.perform(w, input, controller, combined);
    this.jobs.set(w.id, job);
    return job.finally(() => { this.jobs.delete(w.id); this.active.delete(w.id); }) as Promise<T>;
  }
  private async perform<T>(w: Write, input: { caller: PetIdentity; prepare?: (signal: AbortSignal) => Promise<unknown>; requireApproval?: boolean; validate: () => void; execute: (signal: AbortSignal) => Promise<T> }, controller: AbortController, signal: AbortSignal) {
    const timer = setTimeout(() => controller.abort(), Math.max(0, Date.parse(w.expiresAt) - this.now()));
    let abort!: () => void;
    try {
      signal.throwIfAborted();
      const cancelled = new Promise<undefined>(resolve => { abort = () => resolve(undefined); signal.addEventListener("abort", abort, { once: true }); });
      if (input.prepare) {
        const prepared = await Promise.race([input.prepare(signal), cancelled]);
        signal.throwIfAborted(); input.validate();
        if (Buffer.byteLength(JSON.stringify(prepared)) > 128 * 1024) throw new HouseholdError("This change is too large to review in a chat. Split it into smaller changes.");
        w.params = structuredClone(prepared); this.put(w);
      }
      const answer = input.requireApproval === false ? "approved" : await Promise.race([this.approval?.ask(input.caller, view(w), signal), cancelled]);
      if (answer !== "approved" || signal.aborted || this.now() >= Date.parse(w.expiresAt)) {
        w.state = answer === "denied" && !signal.aborted ? "denied" : "cancelled";
        w.detail = signal.aborted ? "Approval expired, access was revoked or the call was cancelled." : "No owner approval was granted. Nothing changed.";
        this.put(w); return this.prior(w);
      }
      clearTimeout(timer);
      input.validate(); signal.throwIfAborted();
      w.state = "executing"; this.put(w);
      const result = await input.execute(signal);
      w.state = "succeeded"; w.result = result; this.put(w);
      return result;
    } catch (error) {
      if (w.state === "executing") { w.state = "unknown"; w.detail = "The change may have happened. Inspect the account; this request will never execute again."; }
      else if (w.state === "pending") { w.state = "cancelled"; w.detail = "Approval could not be completed. Nothing changed."; }
      this.put(w);
      if (w.state === "unknown") return this.prior(w);
      if (error instanceof HouseholdError) throw error;
      return this.prior(w);
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); controller.abort(); }
  }
  stop() { this.stopped = true; for (const controller of this.active.values()) controller.abort(); }
}
