import { CLOCK, type Clock } from "../core/clock";
import type { House } from "../core/household";
import { isWholeInternet } from "../core/network-policy";
import { NAME_PATTERN } from "../core/names";
import { availableTo, envProblem, formatHosts, secretHost, secretPlaceholder, type Secret } from "../core/secrets";
import { carriesHouseholdTag } from "../core/tags";
import type { PetIdentity } from "../infra/agent-api";
import type { McpTool } from "../infra/mcp-server";
import type { OwnerCard } from "./chat";
import { cardText, html } from "../core/card";

export type SecretDecision = "waiting" | "save" | "cancel" | "raw-warning" | "raw-confirm" | "raw-send";
export interface SecretInput {
  house: string;
  pet?: string;
  text: string;
  owner: boolean;
  edited: boolean;
  relayed: boolean;
  sendRaw?(text: string): Promise<void>;
  remove(): Promise<void>;
  /** Explicit channel limitation: accept managed secrets on the host without promising deletion. */
  retainsIncomingSecrets?: boolean;
  notice(text: string): Promise<void>;
  choose(card: OwnerCard<SecretDecision>, signal: AbortSignal): Promise<SecretDecision | undefined>;
}
export interface SecretRequestOptions {
  house(name: string): House | undefined;
  secrets(): readonly Secret[];
  save(house: string, name: string, value: string, hosts: string[], env: string): Promise<void>;
  notice(house: string, pet: string, text: string): Promise<void>;
  choose?(house: string, pet: string, card: OwnerCard<SecretDecision>, signal: AbortSignal): Promise<SecretDecision | undefined>;
  notify(house: string, pet: string, text: string): void;
  log(text: string): void;
  clock?: Clock;
  waitMs?: number;
}
interface Request { house: string; pet: string; name: string; reason: string; id: string; env: string; hosts: string[]; expiresAt: number; controller: AbortController; cancelTimer(): void }
interface Confirmation { house: string; pet?: string; name: string; env: string; value: string; controller: AbortController; cancelTimer(): void }
const COMMAND = /^\s*\/secret(?:@\w+)?(?:\s|$)/i;
const TOKEN = /(?:^|[^\p{L}\p{N}_])(?:ghp_[A-Za-z0-9_]{4,}|github_pat_[A-Za-z0-9_]{4,}|sk-[A-Za-z0-9_-]{4,}|(?:xox[bp]|xapp)-[A-Za-z0-9-]{4,}|AKIA[A-Z0-9]{4,}|-----BEGIN)/u;
const WAIT_MS = 10 * 60_000;
const HOUR = 60 * 60_000;
const MAX_REQUESTS = 10;
const USAGE = "Usage: /secret <name> <value> <domain>[,<domain>…]: the value in one word, the exact domains it is for.";
/** Hosts in a card: each as code, on one line. */
const hostList = (hosts: string[]) => hosts.map(host => `<code>${html(host)}</code>`).join(", ");
const keyOf = (house: string, pet: string) => `${house}/${pet}`;
const validName = (name: unknown): name is string => typeof name === "string" && NAME_PATTERN.test(name);
const safeText = (text: string) => text.replace(/[\p{Cc}\p{Cf}<>]/gu, " ");

/** Requests and unconfirmed values live only in memory. No raw command or failure is logged. */
export class SecretRequests {
  private readonly clock: Clock;
  private readonly pending = new Map<string, Request>();
  private readonly confirmations = new Map<string, Confirmation>();
  private readonly rate = new Map<string, number[]>();
  private readonly rawConfirmations = new Map<string, { pet: string; value: string; controller: AbortController }>();
  private readonly tasks = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly options: SecretRequestOptions) { this.clock = options.clock ?? CLOCK; }

  async request(house: string, pet: string, args: { name: unknown; env: unknown; domains: unknown; reason: unknown }) {
    if (!validName(args.name)) throw new Error("name must start with a–z and contain only a–z, 0–9 or hyphens, up to 31 characters");
    if (typeof args.reason !== "string" || !args.reason.trim() || args.reason.length > 600 || /[\p{Cc}\p{Cf}]/u.test(args.reason) || carriesHouseholdTag(args.reason))
      throw new Error("reason must be 1–600 characters without control characters or Household tags");
    if (typeof args.env !== "string" || envProblem(args.env)) throw new Error("env must be a non-reserved uppercase environment variable name (A–Z, 0–9, _; up to 64 characters)");
    if (!Array.isArray(args.domains) || args.domains.length < 1 || args.domains.length > 16 || args.domains.some(domain => typeof domain !== "string" || domain.length > 253 || "problem" in secretHost(domain))) throw new Error("domains must contain 1–16 exact hostnames, optionally with ports");
    const hosts = [...new Set(args.domains.map(domain => formatHosts([secretHost(domain) as { host: string; port: number }])[0]!))];
    const env = args.env;
    const { name } = args;
    const configured = this.options.house(house);
    if (this.stopped || !configured?.pets.some(p => p.name === pet) || configured.network.allow.some(isWholeInternet)) return { status: "refused", message: "Secret requests require an existing member of a restricted-network workspace." };
    const existing = this.options.secrets().find(s => s.name === name);
    if (existing) return { status: "refused", message: "That secret name already exists; choose a unique name. Nothing will be overwritten." };
    if (this.options.secrets().some(s => availableTo(s, house) && s.env === env)) return { status: "refused", message: "That env is already used in this workspace; choose a unique environment variable." };
    const key = keyOf(house, pet);
    if (this.confirmations.has(house) || [...this.pending.values()].some(r => r.house === house)) return { status: "busy", message: "This workspace already has an active secret request or confirmation. Wait for its outcome." };
    const recent = (this.rate.get(house) ?? []).filter(t => t > this.clock.now() - HOUR);
    if (recent.length >= MAX_REQUESTS) return { status: "busy", message: "This workspace has reached its hourly secret request limit." };
    recent.push(this.clock.now()); this.rate.set(house, recent);
    const request: Request = { house, pet, name, reason: args.reason.trim(), id: `r${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, env, hosts, expiresAt: this.clock.now() + (this.options.waitMs ?? WAIT_MS), controller: new AbortController(), cancelTimer: () => {} };
    this.pending.set(key, request);
    request.cancelTimer = this.clock.after(this.options.waitMs ?? WAIT_MS, () => this.finishRequest(request, "expired"));
    const member = configured.pets.find(p => p.name === pet)!;
    try {
      // Who asks and why (its own words, quoted), what it would be, then the one thing to do.
      const text = cardText({
        title: `${html(safeText(member.title ?? member.name))} asks for a secret`,
        quote: { label: "Why", text: request.reason },
        facts: [`Secret: <code>${name}</code>`, `For: ${hostList(hosts)}`, `In: <code>$${env}</code>`, "Expires in: 10 minutes"],
        note: "Reply <code>/secret &lt;value&gt;</code>. The pet never sees the value. Household removes your message where supported; otherwise delete it yourself.",
      });
      if (this.options.choose) {
        const task = this.options.choose(house, pet, {
          text, format: "html", start: "waiting",
          view: state => state === "waiting" ? { choices: [["Cancel request"]] } : { outcome: "Cancelled", text: "<b>Secret request cancelled.</b>" },
          press: (state, index) => state === "waiting" && index === 0 ? "cancel" : state,
        }, request.controller.signal).then(() => {
          if (this.pending.get(key) === request) this.finishRequest(request, "cancelled");
        }).catch(() => { if (this.pending.get(key) === request) this.finishRequest(request, "unavailable"); });
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task));
      } else await this.options.notice(house, pet, text);
      if (this.pending.get(key) !== request) return { status: "cancelled" };
      this.options.log(`secret requested: ${house}/${pet} ${name}`);
      return { status: "pending", name, env, request_id: request.id, domains: hosts, message: "Your owner was asked. Continue other work or wait for Household's internal notification; never ask them to send the value directly to you." };
    } catch {
      this.dropRequest(request);
      return { status: "unavailable", message: "The secret request could not be shown in chat. Ask your owner to use Household's admin secrets page." };
    }
  }

  /** Called before chat history/security rejection. True means the message must never reach a journal or pet. */
  async handle(input: SecretInput): Promise<boolean> {
    const command = COMMAND.test(input.text);
    if (!command && !(input.owner && TOKEN.test(input.text))) return false;
    let raw = input.text;
    input.text = "";
    if (input.retainsIncomingSecrets) {
      await input.notice("This chat cannot remove your message. Delete it yourself; the value is withheld from the agent and its history.").catch(() => {});
      // Raw-token forwarding is deliberately unavailable on a retaining channel.
      if (!command) return true;
    } else try { await input.remove(); } catch {
      await input.notice("Could not delete that message: delete it yourself. It was not sent to the agent or saved.").catch(() => {});
      return true;
    }
    if (!command) {
      if (!input.pet || !input.sendRaw || input.edited || input.relayed || this.stopped) {
        await input.notice(`Looks like a secret: deleted, not sent to the agent. ${USAGE}`).catch(() => {});
        return true;
      }
      if (this.rawConfirmations.has(input.house)) {
        await input.notice("Deleted: answer the open question about the last one first.").catch(() => {});
        return true;
      }
      const pending = { pet: input.pet, value: raw, controller: new AbortController() };
      raw = "";
      this.rawConfirmations.set(input.house, pending);
      const task = this.confirmRaw(input, pending);
      this.tasks.add(task);
      void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
      return true;
    }
    if (!input.owner || input.edited || input.relayed) {
      await input.notice("Only the house's owner adds a secret, with a new /secret message. Nothing saved.").catch(() => {});
      return true;
    }
    const fields = raw.trim().split(/\s+/);
    const active = [...this.pending.values()].find(r => r.house === input.house);
    const short = fields.length === 2;
    const request = short ? active : undefined;
    const supplied = short ? fields[1] : fields[2];
    if (fields[0]!.toLowerCase() !== "/secret" || ![2, 4].includes(fields.length) || !supplied || supplied.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(supplied)) {
      await input.notice(USAGE).catch(() => {}); return true;
    }
    if (short && (!request || request.expiresAt <= this.clock.now())) {
      await input.notice(`No secret request is open. Nothing saved. ${USAGE}`).catch(() => {}); return true;
    }
    if (!short && active) {
      await input.notice("A secret request is open: answer it with /secret <value>, or cancel it first.").catch(() => {}); return true;
    }
    const name = request?.name ?? fields[1]!;
    if (!validName(name)) { await input.notice(USAGE).catch(() => {}); return true; }
    const env = request?.env ?? `SECRET_${name.toUpperCase().replaceAll("-", "_")}`;
    let value = supplied!;
    const parsed = (request?.hosts ?? fields[3]!.split(",")).map(secretHost);
    if (parsed.length > 16 || parsed.some(h => "problem" in h)) {
      await input.notice("Domains: 1–16 exact names, a port allowed; no URLs, IP addresses or wildcards. Nothing saved.").catch(() => {}); return true;
    }
    const hosts = [...new Set(parsed.map(h => formatHosts([h as { host: string; port: number }])[0]!))];
    const house = this.options.house(input.house);
    if (this.stopped || !house || house.network.allow.some(isWholeInternet)) {
      await input.notice("Secrets work only in a house with a network allowlist. Nothing saved.").catch(() => {}); return true;
    }
    if (this.options.secrets().some(s => s.name === name)) {
      await input.notice("A secret by that name exists: change it on the admin's Secrets page. /secret never overwrites.").catch(() => {}); return true;
    }
    if (this.confirmations.has(input.house)) {
      await input.notice("Another secret is waiting for your answer: finish it first.").catch(() => {}); return true;
    }
    if (this.options.secrets().some(s => availableTo(s, input.house) && s.env === env)) {
      await input.notice("That variable is taken in this house. Nothing saved.").catch(() => {}); return true;
    }
    const pet = request?.pet ?? input.pet;
    if (pet && !house.pets.some(p => p.name === pet)) {
      await input.notice("The requesting pet is no longer in this house.").catch(() => {}); return true;
    }
    if (request) this.dropRequest(request);
    const pending: Confirmation = { house: input.house, pet, name, env, value, controller: new AbortController(), cancelTimer: () => {} };
    raw = ""; fields.fill(""); value = "";
    this.confirmations.set(input.house, pending);
    let expired = false;
    pending.cancelTimer = this.clock.after(request ? Math.max(0, request.expiresAt - this.clock.now()) : (this.options.waitMs ?? WAIT_MS), () => { expired = true; pending.value = ""; pending.controller.abort(); });
    // Pass only safe context to the background task; the raw command and its split fields go out of scope now.
    const task = this.confirm(pending, hosts, input.choose, input.notice, () => expired);
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return true;
  }

  private async confirmRaw(input: SecretInput, pending: { pet: string; value: string; controller: AbortController }): Promise<void> {
    const cancelTimer = this.clock.after(this.options.waitMs ?? WAIT_MS, () => {
      pending.value = "";
      pending.controller.abort();
    });
    const card: OwnerCard<SecretDecision> = {
      text: cardText({ title: "🔒 Looks like a secret", note: "Deleted before the agent saw it. To keep it out of the VM, add it with <code>/secret &lt;name&gt; &lt;value&gt; &lt;domain&gt;</code>. Or send it as is (within 10 minutes)." }),
      format: "html", start: "raw-warning",
      view: state => state === "raw-warning" ? { choices: [["Send anyway"], ["Cancel"]] }
        : state === "raw-confirm" ? {
          text: cardText({ title: "Send it as is?", note: "The agent and its model provider see the value, and it stays in the chat history." }),
          choices: [["Yes, send raw secret"], ["No"]],
        } : { outcome: state === "raw-send" ? "Sending approved" : "Not sent", text: state === "raw-send" ? "<b>Sent as is</b> to the agent." : "<b>Not sent</b> to the agent." },
      press: (state, index) => state === "raw-warning" ? index === 0 ? "raw-confirm" : "cancel"
        : state === "raw-confirm" ? index === 0 ? "raw-send" : "cancel" : state,
    };
    try {
      const decision = await input.choose(card, pending.controller.signal);
      if (decision !== "raw-send" || pending.controller.signal.aborted || this.stopped) return;
      if (!this.options.house(input.house)?.pets.some(pet => pet.name === pending.pet)) return;
      const value = pending.value;
      pending.value = "";
      await input.sendRaw!(value);
    } catch {
      await input.notice("Could not forward the message. Check the conversation before retrying.").catch(() => {});
    } finally {
      pending.value = "";
      cancelTimer();
      if (this.rawConfirmations.get(input.house) === pending) this.rawConfirmations.delete(input.house);
    }
  }

  private async confirm(pending: Confirmation, hosts: string[], choose: SecretInput["choose"], notice: SecretInput["notice"], expired: () => boolean): Promise<void> {
    const { house, pet, name, env } = pending;
    // Very short values must never be shown in full, even though the normal preview uses three characters.
    const preview = safeText(pending.value.slice(0, Math.min(3, Math.max(0, pending.value.length - 1))));
    // What would be saved, as the request card put it (its reason is on that card), and what the VM gets instead.
    const text = cardText({
      title: "🔑 Save this secret?",
      facts: [`Secret: <code>${name}</code>`, `For: ${hostList(hosts)}`, `In: <code>$${env}</code>`, `Value: <code>${html(preview)}…</code> (${pending.value.length} characters)`],
      note: `The VM only gets <code>${secretPlaceholder(name)}</code>; Household puts the value in on the way out. Reaching these hosts is a separate network request.`,
    });
    const card: OwnerCard<SecretDecision> = {
      text, format: "html", start: "waiting",
      view: state => state === "waiting" ? { choices: [["Yes, save"], ["Cancel"]] } : { outcome: state === "save" ? "Save approved" : "Cancelled" },
      press: (state, index) => state === "waiting" ? index === 0 ? "save" : index === 1 ? "cancel" : state : state,
    };
    try {
      const aborted = new Promise<undefined>(resolve => pending.controller.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
      const decision = await Promise.race([choose(card, pending.controller.signal), aborted]);
      if (decision !== "save" || pending.controller.signal.aborted || this.stopped) {
        await notice(expired() ? "Secret confirmation expired; nothing was saved." : "Secret confirmation cancelled; nothing was saved.");
        if (pet) this.notify(house, pet, `Secret ${name} request ${expired() ? "expired" : "was cancelled"}. No value is available.`);
        this.options.log(`secret ${expired() ? "expired" : "cancelled"}: ${house}${pet ? `/${pet}` : ""} ${name}`);
        return;
      }
      const configured = this.options.house(house);
      if (!configured || configured.network.allow.some(isWholeInternet) || (pet && !configured.pets.some(p => p.name === pet)) || this.options.secrets().some(s => s.name === name || (availableTo(s, house) && s.env === env))) throw new Error("not applicable");
      pending.cancelTimer();
      const value = pending.value;
      pending.value = "";
      await this.options.save(house, name, value, hosts, env);
      await notice(`✅ Secret ${name} saved for ${hosts.join(", ")}.`);
      if (pet) this.notify(house, pet, `Secret ${name} is available. Use ${secretPlaceholder(name)} in the Authorization header (for example Bearer ${secretPlaceholder(name)}). Domains: ${hosts.join(", ")}. Network access is separate: if a host is blocked, request network_request. No VM restart is needed; ${env} will contain that placeholder on the next VM start. You may export ${env}=${secretPlaceholder(name)} in your current shell now.`);
      this.options.log(`secret saved: ${house}${pet ? `/${pet}` : ""} ${name} hosts=${hosts.join(",")}`);
    } catch {
      await notice("Could not confirm secret activation. Check the admin secrets page before retrying.").catch(() => {});
      if (pet) this.notify(house, pet, `Could not confirm activation of secret ${name}. Ask your owner to check the admin secrets page.`);
      this.options.log(`secret activation unconfirmed: ${house}${pet ? `/${pet}` : ""} ${name}`);
    } finally {
      pending.value = "";
      pending.cancelTimer();
      if (this.confirmations.get(house) === pending) this.confirmations.delete(house);
    }
  }

  private notify(house: string, pet: string, text: string): void {
    try { this.options.notify(house, pet, text); } catch { /* A requester may have left while approval was pending. */ }
  }

  private dropRequest(request: Request): void {
    request.cancelTimer();
    request.controller.abort();
    if (this.pending.get(keyOf(request.house, request.pet)) === request) this.pending.delete(keyOf(request.house, request.pet));
  }
  private finishRequest(request: Request, status: string): void {
    this.dropRequest(request);
    this.notify(request.house, request.pet, `Secret ${request.name} request ${status}. No value was supplied.`);
    this.options.log(`secret request ${status}: ${request.house}/${request.pet} ${request.name}`);
  }
  setPets(pets: { house: string; pet: string }[]): void {
    const present = (house: string, pet: string) => pets.some(p => p.house === house && p.pet === pet);
    for (const [house, pending] of this.rawConfirmations) if (!present(house, pending.pet)) { pending.value = ""; pending.controller.abort(); }
    for (const request of this.pending.values()) if (!present(request.house, request.pet)) this.dropRequest(request);
    for (const pending of this.confirmations.values()) if (pending.pet && !present(pending.house, pending.pet)) { pending.value = ""; pending.controller.abort(); }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const pending of this.rawConfirmations.values()) { pending.value = ""; pending.controller.abort(); }
    for (const request of this.pending.values()) this.dropRequest(request);
    for (const pending of this.confirmations.values()) { pending.value = ""; pending.controller.abort(); }
    await Promise.allSettled(this.tasks);
  }
}

export function secretRequestTool(requests: SecretRequests): McpTool<PetIdentity> {
  return {
    name: "secret_request",
    description: "Ask your human to add a workspace secret. You never receive the value, only a placeholder. Choose unique name and env; domains are exact service hosts approved by the owner. Multiple secrets can share the same domains. One active request per workspace. reason explains why you need it. Returns promptly; Household sends an internal notification when ready or expired. Secret substitution does not grant network access: use network_request separately. Never ask for values through reply or ordinary chat.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name", "env", "domains", "reason"], properties: {
      name: { type: "string" }, env: { type: "string" }, domains: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 }, reason: { type: "string", minLength: 1, maxLength: 600 },
    } },
    async call({ house, pet }, args) { return JSON.stringify(await requests.request(house, pet, { name: args.name, env: args.env, domains: args.domains, reason: args.reason })); },
  };
}
