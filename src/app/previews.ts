import { CLOCK, type Clock } from "../core/clock";
import { houseFeatures, previewSettings } from "../core/house-features";
import type { House } from "../core/household";
import type { PetIdentity } from "../infra/agent-api";
import type { McpTool } from "../infra/mcp-server";
import type { OwnerCard } from "./chat";
import { cardText, html } from "../core/card";

export const PREVIEW_TTL_MS = 15 * 60_000;
export const PREVIEW_WAIT_MS = 5 * 60_000;
export interface PreviewView extends PetIdentity {
  id: string; port: number; title: string; status: "pending" | "opening" | "active";
  requested_at: string; url?: string; expires_at?: string;
}
export interface PreviewListener { url: string; close(): Promise<void> }
interface Entry { view: PreviewView; reason: string; controller: AbortController; cancelTimer(): void; listener?: PreviewListener; done: boolean; result?: string; opening?: Promise<Decision>; closing?: Promise<void> }
type Decision = { state: "waiting" } | { state: "done"; text: string };
export interface PreviewDeps {
  house(name: string): House | undefined;
  ready(caller: PetIdentity): Promise<boolean>;
  open(caller: PetIdentity, port: number, settings: { bindAddress: string; publicHost: string }, signal: AbortSignal): Promise<PreviewListener>;
  choose(caller: PetIdentity, card: OwnerCard<Decision>, signal: AbortSignal): Promise<Decision | undefined>;
  notify(caller: PetIdentity, text: string): void;
  log(caller: PetIdentity, text: string): void;
  clock?: Clock;
}
const same = (a: PetIdentity, b: PetIdentity) => a.house === b.house && a.pet === b.pet;
function text(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error(`${name} must be 1–${max} characters without control characters`);
  return value.trim();
}
/** Ephemeral owner-approved routes. Nothing is persisted or restored after daemon restart. */
export class Previews {
  private entries = new Map<string, Entry>();
  private tasks = new Set<Promise<unknown>>();
  private stopped = false;
  private clock: Clock;
  constructor(private deps: PreviewDeps) { this.clock = deps.clock ?? CLOCK; }
  list(caller: PetIdentity): PreviewView[] { return [...this.entries.values()].filter(e => !e.done && same(e.view, caller)).map(e => ({ ...e.view })); }
  private allowed(caller: PetIdentity) {
    const house = this.deps.house(caller.house);
    return !!house && houseFeatures(house).preview && house.pets.some(p => p.name === caller.pet && p.enabled !== false);
  }
  request(caller: PetIdentity, args: Record<string, unknown>) {
    if (this.stopped || !this.allowed(caller)) throw new Error("HTTP previews are disabled for this house or pet. Ask your owner to enable them in house settings.");
    if (typeof args.port !== "number" || !Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error("port must be an integer from 1 to 65535 in your own VM");
    const title = text(args.title, "title", 100), reason = text(args.reason, "reason", 600);
    const existing = [...this.entries.values()].find(e => same(e.view, caller) && e.view.port === args.port);
    if (existing?.done) throw new Error("This preview is closing; retry once it has closed.");
    if (existing) return { ...existing.view };
    if (this.list(caller).length >= 8) throw new Error("Close a preview before requesting another (8 per pet maximum).");
    const entry: Entry = { view: { ...caller, id: crypto.randomUUID(), port: args.port, title, status: "pending", requested_at: new Date(this.clock.now()).toISOString() }, reason, controller: new AbortController(), cancelTimer: () => {}, done: false };
    this.entries.set(entry.view.id, entry);
    entry.cancelTimer = this.clock.after(PREVIEW_WAIT_MS, () => { this.track(this.finish(entry, "approval timed out")); });
    this.deps.log(caller, `requested ${entry.view.id} port ${entry.view.port}`);
    this.track(this.ask(entry));
    return { ...entry.view };
  }
  private track(task: Promise<unknown>) {
    this.tasks.add(task);
    void task.catch(() => {}).finally(() => this.tasks.delete(task));
  }
  private async ask(entry: Entry) {
    const house = this.deps.house(entry.view.house)!;
    const settings = previewSettings(house);
    const local = settings.bindAddress === "127.0.0.1" || settings.bindAddress === "::1";
    // Who wants to show what (its words, quoted), then where the link will be and that it has no login.
    const pet = house.pets.find(p => p.name === entry.view.pet)?.title ?? entry.view.pet;
    const question = cardText({
      title: `${html(pet)} wants to show you “${html(entry.view.title)}”`,
      quote: { label: "Why", text: entry.reason },
      facts: [
        `Port: <code>${entry.view.port}</code>`,
        `Link on: <code>${html(settings.publicHost)}</code> (${local ? "this computer only" : "reachable as your network and firewall allow"})`,
        "Open for: 15 minutes",
      ],
      note: "No login: whoever reaches the link sees the app.",
    });
    try {
      const result = await this.deps.choose(entry.view, {
        text: question, format: "html", start: { state: "waiting" },
        cancelledText: () => `<b>Preview closed.</b>\n\n${html(entry.result ?? "Request cancelled")}`,
        view: s => s.state === "waiting" ? { choices: [["Open for 15 minutes"], ["Cancel"]], text: question } : { outcome: "", text: s.text },
        press: s => s,
        act: async (s, index) => {
          if (s.state !== "waiting" || entry.done) return s;
          if (index !== 0) { await this.finish(entry, "denied", false); return { state: "done", text: "<b>Not opened.</b>" }; }
          entry.opening = this.approve(entry, settings);
          return entry.opening;
        },
      }, entry.controller.signal);
      if (!result && !entry.done) await this.finish(entry, "request unavailable");
    } catch { await this.finish(entry, "request unavailable"); }
  }
  private async approve(entry: Entry, settings: { bindAddress: string; publicHost: string }): Promise<Decision> {
    entry.cancelTimer();
    entry.view.status = "opening";
    this.deps.log(entry.view, `approved ${entry.view.id} port ${entry.view.port}`);
    try {
      if (!this.allowed(entry.view) || this.stopped || !await this.deps.ready(entry.view)) throw new Error("The VM is not running or previews are disabled");
      if (entry.done) throw new Error("Request closed");
      // Use the exact owner settings shown in the approval card. A config change cancels pending requests.
      const listener = await this.deps.open(entry.view, entry.view.port, settings, entry.controller.signal);
      if (entry.done || this.stopped || !this.allowed(entry.view)) { await listener.close(); throw new Error("Request closed"); }
      entry.listener = listener;
      entry.view.status = "active";
      entry.view.url = listener.url;
      entry.view.expires_at = new Date(this.clock.now() + PREVIEW_TTL_MS).toISOString();
      entry.cancelTimer = this.clock.after(PREVIEW_TTL_MS, () => { this.track(this.finish(entry, "expired")); });
      this.deps.log(entry.view, `opened ${entry.view.id} port ${entry.view.port}; expires ${entry.view.expires_at}`);
      this.deps.notify(entry.view, `Preview opened: ${JSON.stringify(entry.view)}`);
      return { state: "done", text: `<b>Open for 15 minutes:</b> <a href="${html(listener.url)}">${html(listener.url)}</a>` };
    } catch (error) {
      const message = (error as Error).message;
      if (!entry.done) await this.finish(entry, `opening failed: ${message}`, false, false);
      return { state: "done", text: `<b>Preview could not be opened.</b>\n\n${html(message)}` };
    }
  }
  private async finish(entry: Entry, reason: string, abort = true, waitOpening = true) {
    if (entry.done) return entry.closing;
    entry.done = true; entry.result = reason; entry.cancelTimer();
    if (abort) entry.controller.abort();
    entry.closing = (async () => {
      try {
        await entry.listener?.close();
        if (waitOpening) await entry.opening;
      }
      finally {
        this.entries.delete(entry.view.id);
        this.deps.log(entry.view, `closed ${entry.view.id} port ${entry.view.port}: ${reason}`);
        this.deps.notify(entry.view, `Preview ${entry.view.id} closed: ${reason}. The application inside your VM was not stopped.`);
      }
    })();
    return entry.closing;
  }
  async close(caller: PetIdentity, id: string) {
    const entry = this.entries.get(id);
    if (!entry || !same(entry.view, caller)) throw new Error("Unknown preview for this pet");
    await this.finish(entry, "closed manually");
  }
  async closePet(caller: PetIdentity, reason = "VM stopped") {
    await Promise.all([...this.entries.values()].filter(e => same(e.view, caller)).map(e => this.finish(e, reason)));
  }
  async reconcile(houses: House[]) {
    await Promise.all([...this.entries.values()].filter(e => {
      const house = houses.find(h => h.name === e.view.house);
      const oldHouse = this.deps.house(e.view.house);
      return !house || !houseFeatures(house).preview || !house.pets.some(p => p.name === e.view.pet && p.enabled !== false) || JSON.stringify(previewSettings(house)) !== JSON.stringify(previewSettings(oldHouse ?? house));
    }).map(e => this.finish(e, "house settings changed or VM removed")));
  }
  async stop() {
    this.stopped = true;
    await Promise.all([...this.entries.values()].map(e => this.finish(e, "Household stopped")));
    await Promise.allSettled([...this.tasks]);
  }
}
export function previewTools(previews: Previews): McpTool<PetIdentity>[] {
  return [
    { name: "preview_open", description: "Request owner approval for an HTTP/WebSocket preview of a port in your own VM, for up to 15 minutes. Returns pending; Household sends the result internally. Does not extend an existing preview. See skill household-preview.", inputSchema: { type: "object", properties: { port: { type: "integer", minimum: 1, maximum: 65535 }, title: { type: "string" }, reason: { type: "string" } }, required: ["port", "title", "reason"], additionalProperties: false }, call: async (caller, args) => JSON.stringify(previews.request(caller, args)) },
    { name: "preview_list", description: "List your pending and active HTTP previews, URLs and deadlines.", inputSchema: { type: "object", additionalProperties: false }, call: async caller => JSON.stringify(previews.list(caller)) },
    { name: "preview_close", description: "Close your preview (including active connections), or cancel its pending approval. The app keeps running.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, call: async (caller, args) => { if (typeof args.id !== "string") throw new Error("id is required"); await previews.close(caller, args.id); return JSON.stringify({ status: "closed" }); } },
  ];
}
