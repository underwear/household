import { createHash, randomBytes, randomUUID } from "node:crypto";
import { googleConnectSchema, GOOGLE_SCOPES, GOOGLE_WRITE_SCOPES, type GoogleConnectionView, type GoogleService } from "../core/google-connectors";
import type { House } from "../core/household";
import { HouseholdError } from "../core/errors";
import type { PetIdentity } from "../infra/agent-api";
import type { KeyValueStore } from "../infra/sqlite-store";
import { boundedText, googleClient, googleJson, GoogleHttpError, type GoogleFetch } from "../infra/google/client";
import { decodeMail, googleRequest, operationCatalog } from "../infra/google/operations";
import { TokenBucket } from "./token-bucket";

const KEY = "house.connectors.google.v1";
interface Connection extends GoogleConnectionView { house: string; subject: string; accessToken: string; refreshToken: string; expiresAt: number }
interface Pending { consumed?: boolean; house: string; services: GoogleService[]; write: boolean; pets: string[]; verifier: string; redirect: string; binding: string; expires: number }
const nonce = () => randomBytes(32).toString("base64url");
const scopesFor = (services: GoogleService[], write: boolean) => ["openid", "email", ...services.flatMap(s => [...GOOGLE_SCOPES[s], ...(write ? GOOGLE_WRITE_SCOPES[s] : [])])];

/** Owner-only OAuth enrollment; pets act only through the closed operation registry, and change only what a
 * connection the owner let write was granted. Tokens stay in
 * the host's private SQLite database (and its private backups), never in config views or pet environments. */
export class GoogleConnectors {
  private houses: House[] = [];
  private pending = new Map<string, Pending>();
  private refreshes = new Map<string, Promise<string>>();
  private active = new Map<string, AbortController>();
  private budgets = new Map<string, TokenBucket>();
  constructor(private store: KeyValueStore, private client = googleClient(), private fetcher: GoogleFetch = fetch, private now = Date.now) {}
  private read(): Connection[] { return JSON.parse(this.store.get(KEY) ?? "[]"); }
  private write(items: Connection[]) { this.store.set(KEY, JSON.stringify(items)); }
  private view(c: Connection): GoogleConnectionView {
    return { id: c.id, email: c.email, services: [...c.services], writable: [...(c.writable ?? [])], pets: [...c.pets], connectedAt: c.connectedAt, needsReconnect: c.needsReconnect };
  }
  setHouses(houses: House[]) {
    this.houses = houses;
    const saved = this.read();
    const kept = saved.filter(c => houses.some(h => h.name === c.house));
    for (const c of saved) if (!kept.includes(c)) this.abort(c.id);
    for (const c of kept) c.pets = c.pets.filter(p => houses.find(h => h.name === c.house)?.pets.some(pet => pet.name === p && !pet.sideworker && !pet.scout));
    this.write(kept);
    for (const [state, pending] of this.pending) if (!houses.some(h => h.name === pending.house) || pending.expires <= this.now()) this.pending.delete(state);
  }
  private house(name: string) {
    const house = this.houses.find(h => h.name === name);
    if (!house) throw new HouseholdError("Workspace not found");
    return house;
  }
  private pets(house: string, pets: string[]) {
    const configured = this.house(house).pets;
    if (pets.some(name => !configured.some(p => p.name === name && !p.scout && !p.sideworker))) throw new HouseholdError("Select configured bots from this workspace");
    return [...new Set(pets)];
  }
  list(house: string) {
    this.house(house);
    return { ready: !!this.client.id && !!this.client.secret, connections: this.read().filter(c => c.house === house).map(c => this.view(c)) };
  }
  begin(house: string, input: unknown, origin: string, binding: string) {
    const parsed = googleConnectSchema.safeParse(input);
    if (!parsed.success) throw new HouseholdError("Select services and bots for this connection");
    const pets = this.pets(house, parsed.data.pets);
    if (!this.client.id || !this.client.secret) throw new HouseholdError("Google OAuth is not configured in this build");
    const base = new URL(origin);
    if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname) || base.username || base.password) throw new HouseholdError("Connect Google from the local Household dashboard");
    for (const [key, p] of this.pending) if (p.expires <= this.now()) this.pending.delete(key);
    if (this.pending.size >= 20) throw new HouseholdError("Too many pending connections; retry in ten minutes");
    const state = nonce(), verifier = nonce();
    const services = [...new Set(parsed.data.services)];
    const redirect = `${base.origin}/api/connectors/google/callback`;
    this.pending.set(state, { house, services, write: parsed.data.write, pets, verifier, redirect, binding, expires: this.now() + 600_000 });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: this.client.id, redirect_uri: redirect, response_type: "code", scope: scopesFor(services, parsed.data.write).join(" "), state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", access_type: "offline", prompt: "consent select_account" }).toString();
    return { url: url.toString() };
  }
  async finish(url: URL, binding: string) {
    const state = url.searchParams.get("state") ?? "";
    const p = this.pending.get(state);
    if (!p || p.consumed || p.expires <= this.now() || p.binding !== binding || `${url.origin}${url.pathname}` !== p.redirect) throw new HouseholdError("Google sign-in expired or does not match this dashboard; start again");
    p.consumed = true; // keep a consumed entry while exchanging so reconciliation can cancel it
    this.pets(p.house, p.pets);
    if (url.searchParams.has("error")) { this.pending.delete(state); throw new HouseholdError("Google connection was not authorized"); }
    const code = url.searchParams.get("code");
    if (!code || code.length > 4096) throw new HouseholdError("Missing Google authorization code");
    try {
      const tokens = await this.token({ code, redirect_uri: p.redirect, code_verifier: p.verifier, grant_type: "authorization_code" });
      if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") throw new Error("missing tokens");
      const identity = await googleJson(this.fetcher, "https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
      if (typeof identity.sub !== "string" || typeof identity.email !== "string" || identity.email_verified !== true) throw new Error("invalid identity");
      const granted = new Set(typeof tokens.scope === "string" ? tokens.scope.split(" ") : []);
      const services = p.services.filter(s => GOOGLE_SCOPES[s].every(scope => granted.has(scope)));
      if (!services.length) throw new HouseholdError("No requested service was authorized; connect again and allow at least one service");
      // A write scope left unticked on Google's screen leaves its service readable, not gone.
      const writable = p.write ? services.filter(s => GOOGLE_WRITE_SCOPES[s].every(scope => granted.has(scope))) : [];
      if (this.pending.get(state) !== p) throw new HouseholdError("Connection was cancelled; start again");
      this.pets(p.house, p.pets); // house/pets can have been removed during OAuth
      const items = this.read();
      const old = items.find(c => c.house === p.house && c.subject === identity.sub);
      // Reconnecting replaces this account's grants and services; no accumulated hidden permissions.
      if (old) this.abort(old.id);
      const c: Connection = { id: randomUUID(), house: p.house, subject: identity.sub, email: identity.email, services, writable, pets: p.pets, connectedAt: new Date(this.now()).toISOString(), accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: this.expiry(tokens.expires_in), needsReconnect: false };
      this.write([...items.filter(i => i !== old), c]);
      return p.house;
    } catch (error) {
      if (error instanceof HouseholdError) throw error;
      throw new HouseholdError("Google connection failed; check the enabled APIs and OAuth permissions, then try again");
    } finally { this.pending.delete(state); }
  }
  private expiry(seconds: unknown) { return this.now() + (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000; }
  private token(params: Record<string, string>) {
    return googleJson(this.fetcher, "https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: this.client.id, client_secret: this.client.secret, ...params }) });
  }
  setPets(house: string, id: string, pets: string[]) {
    const allowed = this.pets(house, pets), items = this.read();
    const c = items.find(c => c.house === house && c.id === id);
    if (!c) throw new HouseholdError("Connection not found");
    c.pets = allowed; this.write(items); this.abort(id);
    return this.view(c);
  }
  private abort(id: string) { this.active.get(id)?.abort(); this.active.delete(id); }
  disconnect(house: string, id: string) {
    this.house(house);
    const items = this.read();
    if (!items.some(c => c.house === house && c.id === id)) throw new HouseholdError("Connection not found");
    this.abort(id); this.write(items.filter(c => c.house !== house || c.id !== id));
    // Google revocation affects the entire shared client grant, including other houses/installations.
    // Disconnect deletes this local connection only; the UI links to Google's account-wide revocation.
  }
  private parent(caller: PetIdentity): string | undefined {
    const house = this.houses.find(h => h.name === caller.house);
    const pet = house?.pets.find(p => p.name === caller.pet);
    if (!pet || pet.scout || pet.enabled === false) return;
    const parent = pet.sideworker ? house?.pets.find(p => p.name === pet.sideworker!.parent && !p.sideworker && !p.scout && p.enabled !== false) : pet;
    return parent?.name;
  }
  available(caller: PetIdentity) { return this.parent(caller) !== undefined; }
  accounts(caller: PetIdentity) {
    const parent = this.parent(caller);
    return parent ? this.read().filter(c => c.house === caller.house && c.pets.includes(parent)).map(c => this.view(c)) : [];
  }
  catalog(caller: PetIdentity) {
    const accounts = this.accounts(caller);
    return operationCatalog([...new Set(accounts.flatMap(c => c.services))], [...new Set(accounts.flatMap(c => c.writable))]);
  }
  private allowed(caller: PetIdentity, id: string, service: GoogleService, write = false) {
    const parent = this.parent(caller);
    const c = parent && this.read().find(c => c.id === id && c.house === caller.house && c.pets.includes(parent) && c.services.includes(service));
    if (!c) throw new HouseholdError("Google connection or service unavailable to this bot");
    if (write && !c.writable?.includes(service)) throw new HouseholdError(`This account's ${service} is read only; the owner can reconnect it with Read and write on the workspace's Connectors page`);
    if (c.needsReconnect) throw new HouseholdError("Reconnect this Google account in the workspace's Connectors page");
    return c;
  }
  private async access(c: Connection): Promise<string> {
    if (c.expiresAt > this.now() + 60_000) return c.accessToken;
    if (this.refreshes.has(c.id)) return this.refreshes.get(c.id)!;
    const refresh = (async () => {
      try {
        const tokens = await this.token({ grant_type: "refresh_token", refresh_token: c.refreshToken });
        if (typeof tokens.access_token !== "string") throw new Error("missing token");
        const items = this.read(), current = items.find(i => i.id === c.id);
        if (!current) throw new HouseholdError("Connection was removed");
        current.accessToken = tokens.access_token; current.expiresAt = this.expiry(tokens.expires_in);
        if (typeof tokens.refresh_token === "string") current.refreshToken = tokens.refresh_token;
        this.write(items); return current.accessToken;
      } catch (error) {
        if (error instanceof GoogleHttpError && error.reason === "invalid_grant") {
          const items = this.read(), current = items.find(i => i.id === c.id);
          if (current) { current.needsReconnect = true; this.write(items); }
          throw new HouseholdError("Google authorization expired or was revoked; reconnect this account");
        }
        throw new HouseholdError("Could not refresh Google authorization; retry or reconnect this account");
      }
    })();
    this.refreshes.set(c.id, refresh);
    try { return await refresh; } finally { this.refreshes.delete(c.id); }
  }
  async request(caller: PetIdentity, id: string, operation: string, params: unknown, signal?: AbortSignal) {
    const { url, spec, init } = googleRequest(operation, params);
    const write = spec.write === true;
    const c = this.allowed(caller, id, spec.service, write);
    const budgetKey = `${caller.house}/${caller.pet}`;
    if (!this.budgets.has(budgetKey)) this.budgets.set(budgetKey, new TokenBucket(1, 10));
    if (!this.budgets.get(budgetKey)!.take()) throw new HouseholdError("Too many Google requests; retry shortly");
    if (!this.active.has(id)) this.active.set(id, new AbortController());
    const controller = this.active.get(id)!;
    try {
      const access = await this.access(c);
      this.allowed(caller, id, spec.service, write);
      const response = await this.fetcher(url, { method: init.method, body: init.body, headers: { ...init.headers, authorization: `Bearer ${access}` }, redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) });
      if (!response.ok) { await response.body?.cancel(); throw new GoogleHttpError(response.status); }
      const raw = await boundedText(response);
      if (controller.signal.aborted) throw new Error("cancelled");
      // A change went through even if access was revoked meanwhile: say what happened rather than hide it.
      if (!write) this.allowed(caller, id, spec.service);
      const data = spec.text ? { text: raw } : !raw.trim() ? { done: true } : spec.message ? decodeMail(JSON.parse(raw)) : JSON.parse(raw);
      return { trust: "external", data };
    } catch (error) {
      if (error instanceof HouseholdError) throw error;
      if (error instanceof GoogleHttpError) throw new HouseholdError(`Google returned ${error.status}. Check access, enabled APIs and permissions; reconnect if authorization was revoked.`);
      if (error instanceof Error && error.message.startsWith("Google response too large")) throw new HouseholdError(error.message);
      throw new HouseholdError("Google request failed or was cancelled; retry with a narrower request");
    }
  }
  stop() { for (const id of this.active.keys()) this.abort(id); this.pending.clear(); }
}
