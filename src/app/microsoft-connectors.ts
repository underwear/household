import { connectorCallers, connectorWritePolicy, connectorWritePolicySchema, type ConnectorWritePolicy } from "../core/connector-write-policy";
import type { ConnectorWrites } from "./connector-writes";
import { randomUUID } from "node:crypto";
import { microsoftConnectSchema, type MicrosoftConnectionView, type MicrosoftAuthorizationView, type MicrosoftPollView } from "../core/microsoft-connectors";
import type { House } from "../core/household";
import { HouseholdError } from "../core/errors";
import type { PetIdentity } from "../infra/agent-api";
import type { KeyValueStore } from "../infra/sqlite-store";
import { microsoftClient, MICROSOFT_AUTHORITY, microsoftJson, MicrosoftHttpError, type MicrosoftFetch } from "../infra/microsoft/client";
import { microsoftCatalog, microsoftPage, microsoftRequest } from "../infra/microsoft/operations";
import { TokenBucket } from "./token-bucket";

const KEY = "house.connectors.microsoft.v1";
interface Connection extends MicrosoftConnectionView { house: string; subject: string; clientId: string; accessToken: string; refreshToken: string; expiresAt: number }
interface Pending { house: string; pets: string[]; write: boolean; writePolicy: ConnectorWritePolicy; binding: string; deviceCode?: string; expires: number; interval: number; nextPoll: number; busy: boolean; controller: AbortController }
const grantedScopes = (value: unknown) => new Set(typeof value === "string" ? value.split(" ").map(s => s.replace(/^https:\/\/graph.microsoft.com\//i, "").toLowerCase()) : []);
const canRead = (scopes: Set<string>) => scopes.has("tasks.read") || scopes.has("tasks.readwrite");

/** The host owns OAuth and tokens; bots can call only the fixed To Do operation registry. */
export class MicrosoftConnectors {
  private houses: House[] = [];
  private pending = new Map<string, Pending>();
  private refreshes = new Map<string, Promise<string>>();
  private active = new Map<string, AbortController>();
  private budgets = new Map<string, TokenBucket>();
  constructor(private store: KeyValueStore, private client = microsoftClient(), private fetcher: MicrosoftFetch = fetch, private now = Date.now, private writes?: ConnectorWrites) {}
  private read(): Connection[] { return JSON.parse(this.store.get(KEY) ?? "[]"); }
  private write(items: Connection[]) { this.store.set(KEY, JSON.stringify(items)); }
  private view(c: Connection): MicrosoftConnectionView { return { writePolicy: connectorWritePolicy(c.writePolicy, c.writable), id: c.id, account: c.account, displayName: c.displayName, writable: c.writable, pets: [...c.pets], connectedAt: c.connectedAt, needsReconnect: c.needsReconnect || c.clientId !== this.client.id }; }
  private house(name: string) { const h = this.houses.find(h => h.name === name); if (!h) throw new HouseholdError("Workspace not found"); return h; }
  private pets(house: string, names: string[]) {
    const configured = this.house(house).pets;
    if (names.some(name => !configured.some(p => p.name === name && !p.scout && !p.sideworker && p.enabled !== false))) throw new HouseholdError("Select enabled configured bots from this workspace");
    return [...new Set(names)];
  }
  setHouses(houses: House[]) {
    const beforeCallers = new Map(this.read().map(c => [c.id, connectorCallers(this.houses, c.house, c.pets)]));
    this.houses = structuredClone(houses);
    const saved = this.read(), kept = saved.filter(c => houses.some(h => h.name === c.house));
    for (const c of saved) if (!kept.includes(c)) this.abort(c.id);
    for (const c of kept) {
      const pets = c.pets.filter(name => houses.find(h => h.name === c.house)?.pets.some(p => p.name === name && !p.scout && !p.sideworker && p.enabled !== false));
      if (pets.length !== c.pets.length) this.abort(c.id);
      c.pets = pets;
    }
    for (const c of kept) {
      const after = connectorCallers(houses, c.house, c.pets);
      if (beforeCallers.get(c.id)?.some(name => !after.includes(name))) this.abort(c.id);
    }
    this.write(kept);
    for (const [id, p] of this.pending) {
      if (p.expires <= this.now() || !houses.some(h => h.name === p.house && p.pets.every(name => h.pets.some(pet => pet.name === name && !pet.scout && !pet.sideworker && pet.enabled !== false)))) this.drop(id);
    }
  }
  list(house: string) { this.house(house); return { ready: !!this.client.id, connections: this.read().filter(c => c.house === house).map(c => this.view(c)) }; }
  private drop(id: string) { this.pending.get(id)?.controller.abort(); this.pending.delete(id); }
  private enrollment(house: string, id: string, binding: string) {
    const p = this.pending.get(id);
    if (!p || p.house !== house || p.binding !== binding) throw new HouseholdError("Microsoft sign-in does not match this dashboard; start again");
    if (p.expires <= this.now()) { this.drop(id); throw new HouseholdError("Microsoft sign-in expired; start again"); }
    this.pets(house, p.pets); return p;
  }
  async begin(house: string, input: unknown, binding: string): Promise<MicrosoftAuthorizationView> {
    const parsed = microsoftConnectSchema.safeParse(input);
    if (!parsed.success) throw new HouseholdError("Select access and bots for this connection");
    const pets = this.pets(house, parsed.data.pets);
    const writePolicy = connectorWritePolicy(parsed.data.writePolicy, parsed.data.write);
    if (!this.client.id) throw new HouseholdError("Microsoft OAuth is not configured on this host");
    for (const [id, p] of this.pending) if (p.expires <= this.now()) this.drop(id);
    if (this.pending.size >= 20) throw new HouseholdError("Too many pending connections; retry later");
    const id = randomUUID();
    const p: Pending = { house, pets, write: writePolicy !== "disabled", writePolicy, binding, expires: this.now() + 900_000, interval: 5, nextPoll: 0, busy: false, controller: new AbortController() };
    this.pending.set(id, p);
    try {
      const data = await microsoftJson(this.fetcher, `${MICROSOFT_AUTHORITY}/devicecode`, { method: "POST", body: new URLSearchParams({ client_id: this.client.id, scope: `offline_access User.Read ${p.write ? "Tasks.ReadWrite" : "Tasks.Read"}` }), signal: AbortSignal.any([p.controller.signal, AbortSignal.timeout(30_000)]) });
      const uri = new URL(data.verification_uri);
      if (!(["https://microsoft.com", "https://www.microsoft.com", "https://login.microsoftonline.com", "https://login.microsoft.com"].includes(uri.origin)) || uri.username || uri.password || uri.hash || typeof data.device_code !== "string" || !data.device_code || typeof data.user_code !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(data.user_code) || typeof data.expires_in !== "number" || data.expires_in <= 0) throw new Error("invalid device response");
      if (this.pending.get(id) !== p) throw new Error("cancelled");
      p.deviceCode = data.device_code;
      p.expires = this.now() + Math.min(data.expires_in, 900) * 1000;
      p.interval = typeof data.interval === "number" && Number.isFinite(data.interval) ? Math.max(5, Math.min(60, data.interval)) : 5;
      p.nextPoll = this.now() + p.interval * 1000;
      return { id, userCode: data.user_code, verificationUri: uri.toString(), expiresAt: new Date(p.expires).toISOString(), interval: p.interval };
    } catch {
      this.drop(id);
      throw new HouseholdError("Could not start Microsoft sign-in; check the app registration and Allow public client flows");
    }
  }
  cancel(house: string, id: string, binding: string) { this.enrollment(house, id, binding); this.drop(id); }
  private token(params: Record<string, string>, signal?: AbortSignal) { return microsoftJson(this.fetcher, `${MICROSOFT_AUTHORITY}/token`, { method: "POST", body: new URLSearchParams({ client_id: this.client.id, ...params }), ...(signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) } : {}) }); }
  async poll(house: string, id: string, binding: string): Promise<MicrosoftPollView> {
    const p = this.enrollment(house, id, binding);
    if (p.busy || this.now() < p.nextPoll || !p.deviceCode) return { status: "pending", interval: Math.max(p.interval, Math.ceil((p.nextPoll - this.now()) / 1000)) };
    p.busy = true; p.nextPoll = this.now() + p.interval * 1000;
    try {
      const tokens = await this.token({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: p.deviceCode }, p.controller.signal);
      if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") throw new Error("missing tokens");
      const scopes = grantedScopes(tokens.scope);
      if (!canRead(scopes)) throw new Error("missing task permission");
      const identity = await microsoftJson(this.fetcher, "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.any([p.controller.signal, AbortSignal.timeout(30_000)]) });
      if (typeof identity.id !== "string" || !identity.id) throw new Error("missing identity");
      if (this.pending.get(id) !== p) throw new Error("cancelled");
      this.enrollment(house, id, binding);
      const items = this.read(), old = items.find(c => c.house === house && c.subject === identity.id);
      if (old) this.abort(old.id);
      const account = [identity.mail, identity.userPrincipalName, identity.displayName].find(v => typeof v === "string" && v.length) ?? identity.id;
      const c: Connection = { id: randomUUID(), house, subject: identity.id, clientId: this.client.id, account, displayName: typeof identity.displayName === "string" ? identity.displayName : account, pets: p.pets, writable: p.write && scopes.has("tasks.readwrite"), accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: this.expiry(tokens.expires_in), writePolicy: p.writePolicy, connectedAt: new Date(this.now()).toISOString(), needsReconnect: false };
      this.write([...items.filter(i => i !== old), c]);
      this.drop(id); return { status: "connected" };
    } catch (error) {
      if (error instanceof MicrosoftHttpError && this.pending.get(id) === p) {
        if (error.reason === "authorization_pending" || error.reason === "slow_down" || error.status === 429 || error.status >= 500) {
          if (error.reason === "slow_down") p.interval = Math.min(60, p.interval + 5);
          const retry = Math.max(p.interval, Math.min(900, Number(error.retryAfter) || 0));
          p.nextPoll = this.now() + retry * 1000;
          return { status: "pending", interval: retry };
        }
      }
      this.drop(id);
      throw new HouseholdError("Microsoft sign-in failed, expired or was declined. Start again; work accounts may need administrator approval or may block device-code sign-in");
    } finally { p.busy = false; }
  }
  private expiry(seconds: unknown) { return this.now() + (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000; }
  setPets(house: string, id: string, pets: string[], policy?: ConnectorWritePolicy) {
    const allowed = this.pets(house, pets), items = this.read(), c = items.find(c => c.house === house && c.id === id);
    if (!c) throw new HouseholdError("Connection not found");
    if (policy !== undefined) c.writePolicy = connectorWritePolicySchema.parse(policy);
    c.pets = allowed; this.write(items); this.abort(id); return this.view(c);
  }
  private abort(id: string) { this.active.get(id)?.abort(); this.active.delete(id); }
  disconnect(house: string, id: string) {
    this.house(house); const items = this.read();
    if (!items.some(c => c.house === house && c.id === id)) throw new HouseholdError("Connection not found");
    this.abort(id); this.write(items.filter(c => c.house !== house || c.id !== id));
    // Local removal; account-wide provider consent revocation is a separate owner action.
  }
  private parent(caller: PetIdentity) {
    const house = this.houses.find(h => h.name === caller.house), pet = house?.pets.find(p => p.name === caller.pet);
    if (!pet || pet.scout || pet.enabled === false) return;
    return (pet.sideworker ? house?.pets.find(p => p.name === pet.sideworker!.parent && !p.sideworker && !p.scout && p.enabled !== false) : pet)?.name;
  }
  available(caller: PetIdentity) { return this.parent(caller) !== undefined; }
  accounts(caller: PetIdentity) { const parent = this.parent(caller); return parent ? this.read().filter(c => c.house === caller.house && c.pets.includes(parent)).map(c => this.view(c)) : []; }
  catalog(caller: PetIdentity) { const accounts = this.accounts(caller); return accounts.length ? microsoftCatalog(accounts.some(c => c.writable && c.writePolicy !== "disabled")) : []; }
  private allowed(caller: PetIdentity, id: string, write = false) {
    const parent = this.parent(caller), c = parent && this.read().find(c => c.id === id && c.house === caller.house && c.pets.includes(parent));
    if (!c) throw new HouseholdError("Microsoft connection unavailable to this bot");
    if (c.needsReconnect || c.clientId !== this.client.id) throw new HouseholdError("Reconnect this Microsoft account in Connectors");
    if (write && (!c.writable || connectorWritePolicy(c.writePolicy, c.writable) === "disabled")) throw new HouseholdError("This Microsoft account is read only; choose Ask me first or Full access; reconnect if write permission was not granted");
    return c;
  }
  private reconnect(id: string) { const items = this.read(), c = items.find(c => c.id === id); if (c) { c.needsReconnect = true; this.write(items); } }
  private async access(c: Connection, signal: AbortSignal): Promise<string> {
    if (c.expiresAt > this.now() + 60_000) return c.accessToken;
    if (this.refreshes.has(c.id)) return this.refreshes.get(c.id)!;
    const refresh = (async () => {
      try {
        const tokens = await this.token({ grant_type: "refresh_token", refresh_token: c.refreshToken }, signal);
        if (typeof tokens.access_token !== "string") throw new Error("missing token");
        const scopes = grantedScopes(tokens.scope);
        if (tokens.scope !== undefined && !canRead(scopes)) { this.reconnect(c.id); throw new HouseholdError("Microsoft task permission was removed; reconnect this account"); }
        const items = this.read(), current = items.find(i => i.id === c.id);
        if (!current || signal.aborted) throw new HouseholdError("Connection was removed or changed");
        current.accessToken = tokens.access_token; current.expiresAt = this.expiry(tokens.expires_in);
        if (typeof tokens.refresh_token === "string") current.refreshToken = tokens.refresh_token;
        if (tokens.scope !== undefined) current.writable = current.writable && scopes.has("tasks.readwrite");
        this.write(items); return current.accessToken;
      } catch (error) {
        if (error instanceof HouseholdError) throw error;
        if (error instanceof MicrosoftHttpError && ["invalid_grant", "interaction_required", "consent_required", "invalid_client", "unauthorized_client"].includes(error.reason ?? "")) { this.reconnect(c.id); throw new HouseholdError("Microsoft authorization expired or was revoked; reconnect this account"); }
        throw new HouseholdError("Could not refresh Microsoft authorization; retry or reconnect this account");
      }
    })();
    this.refreshes.set(c.id, refresh);
    try { return await refresh; } finally { this.refreshes.delete(c.id); }
  }
  async request(caller: PetIdentity, id: string, operation: string, params: unknown, signal?: AbortSignal, clientRequestId?: string) {
    const { url, spec, init, params: review } = microsoftRequest(operation, params), write = spec.write === true;
    const c = this.allowed(caller, id, write), budgetKey = `${caller.house}/${caller.pet}`;
    if (!this.budgets.has(budgetKey)) this.budgets.set(budgetKey, new TokenBucket(1, 10));
    if (!this.budgets.get(budgetKey)!.take()) throw new HouseholdError("Too many Microsoft requests; retry shortly");
    if (!this.active.has(id)) this.active.set(id, new AbortController());
    const controller = this.active.get(id)!;
    const execute = async (signal?: AbortSignal) => {
      try {
        const access = await this.access(this.allowed(caller, id, write), controller.signal);
        this.allowed(caller, id, write);
        controller.signal.throwIfAborted(); signal?.throwIfAborted();
        const data = await microsoftJson(this.fetcher, url, { ...init, headers: { ...init.headers, authorization: `Bearer ${access}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) });
        // A successful mutation must be reported even if the owner removed access while it was running.
        if (!write) { controller.signal.throwIfAborted(); this.allowed(caller, id); }
        return { trust: "external", data: microsoftPage(data, url) };
      } catch (error) {
        if (error instanceof HouseholdError) throw error;
        if (error instanceof MicrosoftHttpError) {
          if (error.status === 401) this.reconnect(id);
          if (error.status === 429) throw new HouseholdError(`Microsoft rate limit; retry after ${error.retryAfter ?? "a few"} seconds`);
          if (error.status === 412) throw new HouseholdError("This task or list changed; read it again before editing");
          throw new HouseholdError(`Microsoft returned ${error.status}. Check account permissions and reconnect if needed.${write && error.status >= 500 ? " The change may have happened; inspect the task or list before retrying." : ""}`);
        }
        if (write) throw new HouseholdError("Microsoft request failed or was cancelled. The change may have happened; inspect the task or list before retrying");
        if (error instanceof Error && error.message.startsWith("Microsoft response too large")) throw new HouseholdError(error.message);
        throw new HouseholdError("Microsoft request failed or was cancelled; retry with a narrower request");
      }
    };
    if (write && (connectorWritePolicy(c.writePolicy, c.writable) === "approval" || (clientRequestId !== undefined && this.writes))) {
      if (!this.writes) throw new HouseholdError("Connector approval service is unavailable; nothing changed");
      return this.writes.run({ caller, provider: "microsoft", connection: id, account: c.account, operation, requireApproval: connectorWritePolicy(c.writePolicy, c.writable) === "approval", params: review, clientRequestId, signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]), validate: () => { this.allowed(caller, id, true); }, execute });
    }
    return execute(signal);
  }
  stop() { for (const id of this.active.keys()) this.abort(id); for (const id of this.pending.keys()) this.drop(id); }
}
