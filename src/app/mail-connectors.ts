import { createHash, randomUUID } from "node:crypto";
import { MAIL_NO_CHAT, mailConnectionSchema, mailSendSchema, type MailConnectionInput, type MailConnectionView, type MailConnectorsView, type MailSendInput, type MailSendView } from "../core/mail-connectors";
import type { House } from "../core/household";
import { HouseholdError } from "../core/errors";
import type { PetIdentity } from "../infra/agent-api";
import type { KeyValueStore } from "../infra/sqlite-store";
import { mailDriver, mailErrorText, MailTransportError, type MailDriver } from "../infra/mail/client";
import { mailCatalog, mailOperation } from "../infra/mail/operations";
import { TokenBucket } from "./token-bucket";

const KEY = "house.connectors.mail.v1", SENDS = "house.connectors.mail.sends.v1", USED = "house.connectors.mail.used.v1.";
const MAX_ATTACHMENT = 8 * 1024 * 1024, APPROVAL_MS = 10 * 60_000;
const hash = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
interface Connection extends MailConnectionInput { id: string; house: string; revision: string; connectedAt: string }
interface Send extends MailSendView { house: string; revision: string; key: string; inputHash: string; raw?: string }
export interface MailFiles {
  read(caller: PetIdentity, path: string, maxBytes: number): Promise<Uint8Array>;
  save(caller: PetIdentity, name: string, bytes: Uint8Array): Promise<string>;
}
export interface MailApproval {
  /** Shows the immutable message to the owner and returns a decision; no mail transport here. */
  ask(caller: PetIdentity, send: MailSendView, signal: AbortSignal): Promise<"approved" | "denied" | undefined>;
}
const terminal = (s: Send) => !["preparing", "pending", "sending"].includes(s.state);

/** Host credentials and bounded mail operations; agents never receive transport configuration or SMTP access. */
export class MailConnectors {
  private houses: House[] = [];
  private active = new Map<string, AbortController>();
  private waiting = new Map<string, { decide: (answer: "approved" | "denied" | "cancelled") => void; controller: AbortController }>();
  private sending = new Map<string, Promise<MailSendView>>();
  private budgets = new Map<string, TokenBucket>();
  private stopped = false;
  constructor(private store: KeyValueStore, private files: MailFiles, private approval?: MailApproval, private driver: MailDriver = mailDriver, private now = Date.now) {
    // A crash is never a reason to resend or honor an approval from a lost call.
    const sends = this.sends();
    for (const s of sends) {
      this.remember(s);
      if (s.state === "sending") { s.state = "unknown"; s.detail = "Household restarted during submission. The server may have accepted this message; inspect Sent and do not blindly resend."; }
      else if (!terminal(s)) { s.state = "cancelled"; s.detail = "Household restarted before submission."; }
      delete s.raw;
    }
    this.store.set(SENDS, JSON.stringify(sends));
  }
  private connections(): Connection[] { return JSON.parse(this.store.get(KEY) ?? "[]"); }
  private sends(): Send[] { return JSON.parse(this.store.get(SENDS) ?? "[]"); }
  private send(id: string) { const s = this.sends().find(s => s.id === id); if (!s) throw new HouseholdError("Mail send request not found"); return s; }
  private remember(s: Send) {
    // Tiny permanent tombstones are independent of bounded message history. Write before
    // starting work: even a crash between these writes must never permit a second send.
    if (!this.store.get(USED + s.key)) this.store.set(USED + s.key, JSON.stringify({ id: s.id, inputHash: s.inputHash }));
  }
  private putSend(send: Send) {
    this.remember(send);
    const items = this.sends(), index = items.findIndex(s => s.id === send.id);
    if (index < 0) items.push(send); else items[index] = send;
    const cutoff = this.now() - 30 * 86400_000;
    const keep = items.filter(s => !terminal(s) || Date.parse(s.createdAt) >= cutoff);
    const old = keep.filter(terminal).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-100);
    const retained = new Set(old.map(s => s.id));
    // Preserve insertion order, including requests created in the same millisecond.
    this.store.set(SENDS, JSON.stringify(keep.filter(s => !terminal(s) || retained.has(s.id))));
  }
  private sendView(s: Send): MailSendView { const { house, revision, key, inputHash, raw, ...view } = s; return structuredClone(view); }
  private view(c: Connection): MailConnectionView {
    const { house, revision, imap, smtp, ...view } = c;
    const { password: _imapPassword, ...inbound } = imap;
    const outbound = smtp && (({ password, ...rest }) => rest)(smtp);
    return structuredClone({ ...view, imap: inbound, ...(outbound ? { smtp: outbound } : {}) });
  }
  private house(name: string) { const h = this.houses.find(h => h.name === name); if (!h || this.stopped) throw new HouseholdError("Workspace unavailable"); return h; }
  private pets(house: string, names: string[]) {
    const configured = this.house(house).pets;
    if (names.some(name => !configured.some(p => p.name === name && !p.scout && !p.sideworker && p.enabled !== false))) throw new HouseholdError("Select enabled bots from this workspace");
    return [...new Set(names)];
  }
  private parent(caller: PetIdentity) {
    const h = this.houses.find(h => h.name === caller.house), p = h?.pets.find(p => p.name === caller.pet);
    if (!p || p.scout || p.enabled === false || this.stopped) return;
    return (p.sideworker ? h?.pets.find(parent => parent.name === p.sideworker!.parent && !parent.scout && !parent.sideworker && parent.enabled !== false) : p)?.name;
  }
  available(caller: PetIdentity) { return !!this.parent(caller); }
  accounts(caller: PetIdentity) {
    const parent = this.parent(caller);
    return parent ? this.connections().filter(c => c.house === caller.house && c.pets.includes(parent)).map(c => ({ id: c.id, title: c.title, email: c.email, sendPolicy: c.sendPolicy, allowManage: c.allowManage, draftsFolder: c.draftsFolder, trashFolder: c.trashFolder })) : [];
  }
  catalog(caller: PetIdentity) { const accounts = this.accounts(caller); return accounts.length ? mailCatalog(accounts.some(c => c.allowManage)) : []; }
  private allowed(caller: PetIdentity, id: string, manage = false) {
    const parent = this.parent(caller), c = parent && this.connections().find(c => c.id === id && c.house === caller.house && c.pets.includes(parent));
    if (!c) throw new HouseholdError("Mail connection unavailable to this bot");
    if (manage && !c.allowManage) throw new HouseholdError("Mailbox changes are disabled for this connection");
    return c;
  }
  private accountIdentity(c: Connection) { return hash([c.id, c.imap.host, c.imap.port, c.imap.username]); }
  private signal(id: string, signal?: AbortSignal) {
    if (!this.active.has(id)) this.active.set(id, new AbortController());
    return AbortSignal.any([this.active.get(id)!.signal, ...(signal ? [signal] : [])]);
  }
  private budget(caller: PetIdentity) {
    const key = `${caller.house}/${caller.pet}`;
    if (!this.budgets.has(key)) this.budgets.set(key, new TokenBucket(1, 10));
    if (!this.budgets.get(key)!.take()) throw new HouseholdError("Too many mail requests; retry shortly");
  }
  private abort(id: string) {
    this.active.get(id)?.abort(); this.active.delete(id);
    for (const s of this.sends()) if (s.connection === id && ["pending", "preparing"].includes(s.state)) this.cancel(s.id, "Connection access changed.");
  }
  setHouses(houses: House[]) {
    this.houses = houses;
    const all = this.connections(), kept = all.filter(c => houses.some(h => h.name === c.house));
    for (const c of all) if (!kept.includes(c)) this.abort(c.id);
    for (const c of kept) {
      const pets = c.pets.filter(name => houses.find(h => h.name === c.house)?.pets.some(p => p.name === name && !p.scout && !p.sideworker && p.enabled !== false));
      if (pets.length !== c.pets.length) { this.abort(c.id); c.pets = pets; c.revision = randomUUID(); }
    }
    this.store.set(KEY, JSON.stringify(kept));
    for (const s of this.sends()) if (["preparing", "pending"].includes(s.state) && !this.parent({ house: s.house, pet: s.pet })) this.cancel(s.id, "The requesting bot is no longer available.");
  }
  list(house: string): MailConnectorsView { this.house(house); return { connections: this.connections().filter(c => c.house === house).map(c => this.view(c)), sends: this.sends().filter(s => s.house === house).reverse().sort((a, b) => Number(terminal(a)) - Number(terminal(b)) || b.createdAt.localeCompare(a.createdAt)).map(s => this.sendView(s)) }; }
  private input(house: string, input: unknown, old?: Connection): MailConnectionInput {
    const parsed = mailConnectionSchema.safeParse(input);
    if (!parsed.success) throw new HouseholdError("Check mail server, security, sender, permissions and bot settings");
    const value = parsed.data; value.pets = this.pets(house, value.pets);
    for (const kind of ["imap", "smtp"] as const) {
      const endpoint = value[kind], prior = old?.[kind];
      if (!endpoint) continue;
      if (!endpoint.password && prior && endpoint.host === prior.host && endpoint.port === prior.port && endpoint.username === prior.username) endpoint.password = prior.password;
      if (!endpoint.password) throw new HouseholdError(`Enter the ${kind.toUpperCase()} password; retained passwords require the same server, port and username`);
    }
    return value;
  }
  async test(house: string, input: unknown, id?: string) {
    this.house(house);
    const old = id ? this.connections().find(c => c.id === id && c.house === house) : undefined;
    if (id && !old) throw new HouseholdError("Mail connection not found");
    await this.driver(this.input(house, input, old), "probe", {});
    return { ok: true, message: "Mail connection verified. No message was sent or changed." };
  }
  async save(house: string, input: unknown, id?: string) {
    this.house(house);
    const old = id ? this.connections().find(c => c.id === id && c.house === house) : undefined;
    if (id && !old) throw new HouseholdError("Mail connection not found");
    const config = this.input(house, input, old);
    await this.driver(config, "probe", {});
    this.house(house); this.pets(house, config.pets);
    const all = this.connections();
    if (old && !all.some(c => c.id === old.id && c.revision === old.revision)) throw new HouseholdError("Connection changed while testing; reopen it");
    if (!old && all.filter(c => c.house === house).length >= 20) throw new HouseholdError("Maximum 20 mail connections per workspace");
    const c: Connection = { ...config, id: old?.id ?? randomUUID(), house, revision: randomUUID(), connectedAt: old?.connectedAt ?? new Date(this.now()).toISOString() };
    if (old) this.abort(old.id);
    this.store.set(KEY, JSON.stringify([...all.filter(c => c.id !== old?.id), c]));
    return this.view(c);
  }
  disconnect(house: string, id: string) {
    this.house(house);
    const items = this.connections();
    if (!items.some(c => c.house === house && c.id === id)) throw new HouseholdError("Mail connection not found");
    this.abort(id); this.store.set(KEY, JSON.stringify(items.filter(c => c.house !== house || c.id !== id)));
  }
  async request(caller: PetIdentity, id: string, operation: string, input: unknown, signal?: AbortSignal) {
    const { params, manage } = mailOperation(operation, input), c = this.allowed(caller, id, manage);
    const account = this.accountIdentity(c);
    if (params.ref && (params.ref as { account: string }).account !== account) throw new HouseholdError("Message reference belongs to a different mail account; search again");
    const queryKey = hash([params.mailbox, params.query, params.searchMode]);
    if (params.cursor && ((params.cursor as { account: string }).account !== account || (params.cursor as { queryKey: string }).queryKey !== queryKey)) throw new HouseholdError("Search cursor belongs to a different account, mailbox or query");
    this.budget(caller);
    const combined = this.signal(id, signal); combined.throwIfAborted();
    let data: any;
    try {
      if (operation === "drafts.save") {
        const wire = await this.driver(c, "compose", { ...params, messageId: `<${randomUUID()}@household.local>`, date: new Date(this.now()).toUTCString() }, combined);
        this.allowed(caller, id, true); combined.throwIfAborted();
        data = await this.driver(c, operation, { mailbox: c.draftsFolder, raw: wire.raw }, combined);
      } else data = await this.driver(c, operation, params, combined);
      if (!manage) { combined.throwIfAborted(); this.allowed(caller, id); }
      if (operation === "messages.search") {
        data.items = data.items.map((item: any) => ({ ...item, ref: { ...item.ref, account } }));
        if (data.next) data.next = { ...data.next, account, queryKey };
      }
      if (operation === "attachments.download") {
        const bytes = Buffer.from(data.data, "base64");
        if (bytes.length > MAX_ATTACHMENT) throw new HouseholdError("Attachment exceeds 8 MiB");
        const name = String(data.filename).replace(/[/\\\x00-\x1f]/g, "_").slice(0, 180) || "attachment";
        const path = await this.files.save(caller, name, bytes);
        combined.throwIfAborted(); this.allowed(caller, id);
        data = { filename: name, contentType: data.contentType, size: bytes.length, path };
      }
      return { trust: "external", data };
    } catch (error) {
      const reason = error instanceof MailTransportError ? error.message : "Mail operation failed or was cancelled.";
      throw new HouseholdError(manage ? `${reason} The mailbox may have changed; inspect it before retrying.` : reason);
    }
  }
  private cancel(id: string, detail = "Withdrawn before submission.") {
    const s = this.send(id);
    if (!["preparing", "pending"].includes(s.state)) return { cancelled: false, state: s.state, detail: s.state === "sending" ? "Submission has started; cancellation cannot be guaranteed." : "This request has already ended." };
    s.state = "cancelled"; s.detail = detail; delete s.raw; this.putSend(s);
    this.waiting.get(id)?.decide("cancelled"); this.waiting.get(id)?.controller.abort();
    return { cancelled: true, state: s.state };
  }
  cancelSend(caller: PetIdentity, id: string) {
    const s = this.send(id); this.allowed(caller, s.connection);
    if (s.house !== caller.house || s.pet !== caller.pet) throw new HouseholdError("Mail send request unavailable to this bot");
    return this.cancel(id);
  }
  sendStatus(caller: PetIdentity, id?: string) {
    return this.sends().filter(s => s.house === caller.house && s.pet === caller.pet && (!id || s.id === id) && this.accounts(caller).some(c => c.id === s.connection)).map(s => this.sendView(s));
  }
  decide(house: string, id: string, decision: "approved" | "denied" | "cancelled") {
    this.house(house); const s = this.send(id);
    if (s.house !== house) throw new HouseholdError("Mail send request not found");
    if (decision === "cancelled") return this.cancel(id);
    const pending = this.waiting.get(id);
    if (s.state !== "pending" || !pending || Date.parse(s.expiresAt) <= this.now()) throw new HouseholdError("This approval request is no longer pending");
    // First decision wins even before the awaiting continuation runs.
    this.waiting.delete(id); pending.decide(decision); pending.controller.abort();
    return { ok: true };
  }
  async sendMessage(caller: PetIdentity, id: string, input: unknown, signal?: AbortSignal): Promise<MailSendView> {
    const c = this.allowed(caller, id);
    if (c.sendPolicy === "disabled" || !c.smtp) throw new HouseholdError("Sending is disabled for this mail connection");
    const parsed = mailSendSchema.safeParse(input);
    if (!parsed.success) throw new HouseholdError("Invalid outgoing message; supply recipients, subject, text and a unique clientRequestId");
    const params = parsed.data;
    if (params.replyTo && params.replyTo.account !== this.accountIdentity(c)) throw new HouseholdError("Reply reference belongs to a different mail account; search again");
    const key = hash([caller.house, caller.pet, id, params.clientRequestId]), inputHash = hash(params);
    const prior = this.sends().find(s => s.key === key);
    if (prior) {
      if (prior.inputHash !== inputHash) throw new HouseholdError("clientRequestId was already used for a different message; choose a new ID");
      return this.sending.get(prior.id) ?? this.sendView(prior);
    }
    if (this.store.get(USED + key)) throw new HouseholdError("clientRequestId was already used; its message history has expired. No message was resent. Inspect Sent before considering a new send.");
    this.budget(caller);
    if (this.sends().filter(s => !terminal(s)).length >= 20) throw new HouseholdError("Too many mail submissions in progress");
    const requestId = randomUUID(), createdAt = new Date(this.now()).toISOString();
    const s: Send = { id: requestId, connection: id, house: caller.house, pet: caller.pet, revision: c.revision, key, inputHash, from: c.email, to: params.to, cc: params.cc, bcc: params.bcc, subject: params.subject, text: params.text, attachments: [], state: "preparing", messageId: `<${requestId}@household.local>`, createdAt, expiresAt: new Date(this.now() + APPROVAL_MS).toISOString() };
    this.putSend(s);
    const job = this.submit(caller, c, s.id, params, this.signal(id, signal));
    this.sending.set(s.id, job);
    try { return await job; } finally { this.sending.delete(s.id); }
  }
  private async submit(caller: PetIdentity, c: Connection, id: string, params: MailSendInput, signal: AbortSignal): Promise<MailSendView> {
    const cancelled = () => { if (["preparing", "pending"].includes(this.send(id).state)) this.cancel(id, "The originating call was cancelled."); };
    signal.addEventListener("abort", cancelled, { once: true });
    try {
      signal.throwIfAborted();
      const attachments = [], summaries = [];
      let total = 0;
      for (const item of params.attachments) {
        const bytes = await this.files.read(caller, item.path, MAX_ATTACHMENT);
        total += bytes.length;
        if (total > MAX_ATTACHMENT) throw new HouseholdError("Outgoing attachments exceed 8 MiB in total");
        const contentType = /^(message|multipart)\//i.test(item.contentType) ? "application/octet-stream" : item.contentType;
        attachments.push({ filename: item.filename, contentType, data: Buffer.from(bytes).toString("base64") });
        summaries.push({ filename: item.filename, contentType, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
      const replyHeaders = params.replyTo ? await this.driver(c, "reply.headers", { ref: params.replyTo }, signal) : undefined;
      let s = this.send(id);
      const composed = await this.driver(c, "compose", { ...params, attachments, replyHeaders, messageId: s.messageId, date: new Date(s.createdAt).toUTCString() }, signal);
      signal.throwIfAborted();
      s = this.send(id); if (s.state === "cancelled") return this.sendView(s);
      s.raw = composed.raw; s.attachments = summaries;
      if (c.sendPolicy === "approval") {
        s.state = "pending"; this.putSend(s);
        const controller = new AbortController();
        let settle!: (decision: "approved" | "denied" | "cancelled") => void;
        const decision = new Promise<"approved" | "denied" | "cancelled">(resolve => { settle = resolve; });
        this.waiting.set(id, { decide: settle, controller });
        const timer = setTimeout(() => this.cancel(id, "Approval expired before submission."), Math.max(0, Date.parse(s.expiresAt) - this.now()));
        // The owner decides in the bot's chat. No card there (a bot in no channel, a chat that went away): nothing
        // could approve this, so it ends now with why, instead of waiting out its ten minutes unseen.
        if (this.approval) void this.approval.ask(caller, this.sendView(s), controller.signal).then(answer => {
          if (answer && this.waiting.has(id)) this.decide(s.house, id, answer);
          else if (!answer && !controller.signal.aborted && this.waiting.has(id)) this.cancel(id, MAIL_NO_CHAT);
        }).catch(() => {});
        const answer = await decision;
        clearTimeout(timer); this.waiting.delete(id); controller.abort();
        s = this.send(id);
        if (answer !== "approved" || s.state === "cancelled") {
          if (s.state !== "cancelled") { s.state = answer === "denied" ? "denied" : "cancelled"; delete s.raw; this.putSend(s); }
          return this.sendView(s);
        }
      } else this.putSend(s);
      signal.throwIfAborted();
      const current = this.allowed(caller, c.id);
      if (current.revision !== c.revision || current.sendPolicy === "disabled") throw new HouseholdError("Mail connection changed; submit a new request");
      s = this.send(id);
      if (s.state === "cancelled") return this.sendView(s);
      // Synchronous boundary: cancellation and duplicate clicks cannot interleave with this claim.
      s.state = "sending"; this.putSend(s);
      let result;
      try { result = await this.driver(current, "send", { raw: s.raw, recipients: [...new Set([...s.to, ...s.cc, ...s.bcc])] }, signal); }
      catch { result = { delivery: "unknown", error: "mail" }; }
      s = this.send(id);
      if (result.delivery !== "sent") {
        s.state = result.delivery === "not-sent" ? "failed" : "unknown";
        s.detail = s.state === "unknown" ? "SMTP may have accepted the message. Do not automatically resend; inspect Sent and confirm delivery first." : mailErrorText(result.error);
        delete s.raw; this.putSend(s); return this.sendView(s);
      }
      // Commit SMTP acceptance before any separate Sent APPEND. Never retry SMTP for a copy failure.
      const raw = s.raw;
      s.state = "sent"; delete s.raw; this.putSend(s);
      if (current.sentFolder) {
        try {
          signal.throwIfAborted(); this.allowed(caller, c.id);
          await this.driver(current, "append", { mailbox: current.sentFolder, raw }, signal);
        } catch { s.state = "sent-copy-failed"; s.detail = "SMTP accepted this message, but its Sent copy could not be confirmed. Do not send it again."; this.putSend(s); }
      }
      return this.sendView(s);
    } catch (error) {
      const s = this.send(id);
      if (!terminal(s)) { s.state = signal.aborted ? "cancelled" : "failed"; s.detail = error instanceof MailTransportError || error instanceof HouseholdError ? error.message : "Could not prepare the outgoing message. Nothing was submitted."; delete s.raw; this.putSend(s); }
      return this.sendView(s);
    } finally { signal.removeEventListener("abort", cancelled); this.waiting.get(id)?.controller.abort(); this.waiting.delete(id); }
  }
  stop() { this.stopped = true; for (const id of this.active.keys()) this.abort(id); }
}
