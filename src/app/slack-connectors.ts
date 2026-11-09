import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { slackConnectSchema, SLACK_READ_SCOPES, type SlackConnectionView } from "../core/slack-connectors";
import type { House } from "../core/household";
import { HouseholdError } from "../core/errors";
import type { PetIdentity } from "../infra/agent-api";
import type { KeyValueStore } from "../infra/sqlite-store";
import { slackRead, slackWrite, slackOAuth, SlackReadError, type SlackFetch } from "../infra/slack/client";
import { slackCatalog, slackOperation } from "../infra/slack/operations";
import { TokenBucket } from "./token-bucket";

export const SLACK_REDIRECT = "https://agents-household.dev/slack/callback/";
const KEY = "house.connectors.slack.v1";
interface Connection extends SlackConnectionView { house: string; token: string; refreshToken?: string; expiresAt?: number; clientId?: string }
interface Pending { allowWrite: boolean; house: string; pets: string[]; binding: string; redirect: string; verifier: string; expires: number; consumed?: boolean }
const nonce = () => randomBytes(32).toString("base64url");
const oauthInput = z.strictObject({ allowWrite: z.boolean().default(false), pets: z.array(z.string().min(1).max(64)).max(100) });
/** Owner-enrolled user tokens; each grant belongs to one house and explicitly selected regular bots. */
export class SlackConnectors {
  private houses: House[] = [];
  private active = new Map<string, AbortController>();
  private budgets = new Map<string, TokenBucket>();
  private generation = 0;
  private pending = new Map<string, Pending>();
  private refreshes = new Map<string, Promise<string>>();
  constructor(private store: KeyValueStore, private fetcher: SlackFetch = fetch, private clientId = process.env.HOUSEHOLD_SLACK_CLIENT_ID ?? "12549799067478.12553676041489", private now = Date.now) {}
  private read(): Connection[] { return JSON.parse(this.store.get(KEY) ?? "[]"); }
  private write(items: Connection[]) { this.store.set(KEY, JSON.stringify(items)); }
  private view(c: Connection): SlackConnectionView {
    return { id: c.id, teamId: c.teamId, team: c.team, userId: c.userId, user: c.user, scopes: [...c.scopes], pets: [...c.pets], allowWrite: c.allowWrite === true, connectedAt: c.connectedAt, needsReconnect: c.needsReconnect };
  }
  /**
   * A reload (any config write, a sideworker started or closed): only what it took away stops. Connections of a removed
   * house and those a bot can no longer use (removed, disabled) have their reads cancelled; pending sign-ins survive unless their house is gone.
   */
  setHouses(houses: House[]) {
    this.generation++;
    const before = this.houses;
    this.houses = houses;
    const saved = this.read();
    // The bots that can use a connection now: granted, still there, enabled, neither a sideworker nor a scout.
    const usable = (all: House[], c: Connection) => c.pets.filter(p => all.find(h => h.name === c.house)?.pets.some(pet => pet.name === p && pet.enabled !== false && !pet.sideworker && !pet.scout)).join(",");
    const kept = saved.filter(c => houses.some(h => h.name === c.house));
    for (const c of saved) if (!kept.includes(c)) this.abort(c.id);
    for (const c of kept) {
      const pets = c.pets.filter(p => houses.find(h => h.name === c.house)?.pets.some(pet => pet.name === p && !pet.sideworker && !pet.scout));
      if (usable(before, c) !== usable(houses, c)) this.abort(c.id);
      c.pets = pets;
    }
    this.write(kept);
    for (const [state, pending] of this.pending) if (!houses.some(h => h.name === pending.house) || pending.expires <= this.now()) this.pending.delete(state);
  }
  private house(name: string) {
    const house = this.houses.find(h => h.name === name);
    if (!house) throw new HouseholdError("Workspace not found");
    return house;
  }
  private pets(house: string, names: string[]) {
    const pets = this.house(house).pets;
    if (names.some(name => !pets.some(p => p.name === name && !p.scout && !p.sideworker))) throw new HouseholdError("Select configured bots from this workspace");
    return [...new Set(names)];
  }
  list(house: string) { this.house(house); return { oauthReady: !!this.clientId, connections: this.read().filter(c => c.house === house).map(c => this.view(c)) }; }
  begin(house: string, input: unknown, _origin: string, binding: string) {
    const parsed = oauthInput.safeParse(input);
    if (!parsed.success) throw new HouseholdError("Select bots for Slack access");
    const pets = this.pets(house, parsed.data.pets);
    if (!this.clientId) throw new HouseholdError("Slack OAuth is not configured");
    for (const [state, p] of this.pending) if (p.expires <= this.now()) this.pending.delete(state);
    if (this.pending.size >= 20) throw new HouseholdError("Too many pending Slack connections; retry in ten minutes");
    const state = nonce(), verifier = nonce(), redirect = SLACK_REDIRECT;
    this.pending.set(state, { house, pets, allowWrite: parsed.data.allowWrite, binding, redirect, verifier, expires: this.now() + 600_000 });
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.search = new URLSearchParams({ client_id: this.clientId, scope: "", user_scope: [...SLACK_READ_SCOPES, ...(parsed.data.allowWrite ? ["chat:write"] : [])].join(","), redirect_uri: redirect, state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
    return { url: url.toString() };
  }
  async finish(url: URL, binding: string, house?: string) {
    const state = url.searchParams.get("state") ?? "", p = this.pending.get(state);
    if (!p || p.consumed || p.expires <= this.now() || p.binding !== binding || (house !== undefined && p.house !== house) || url.username !== "" || url.password !== "" || url.hash !== "" || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length > 1 || `${url.protocol}//${url.host}${url.pathname}` !== p.redirect) throw new HouseholdError("Slack sign-in expired or does not match this dashboard; start again");
    p.consumed = true;
    try {
      if (url.searchParams.has("error")) throw new HouseholdError("Slack connection was not authorized");
      const code = url.searchParams.get("code");
      if (!code || code.length > 4096) throw new HouseholdError("Missing Slack authorization code");
      this.pets(p.house, p.pets);
      const { data } = await slackOAuth(this.fetcher, { client_id: this.clientId, code, code_verifier: p.verifier, redirect_uri: p.redirect });
      const user = data.authed_user;
      if (!user || typeof user.access_token !== "string" || !user.access_token || user.token_type !== "user") throw new HouseholdError("Slack did not grant user access");
      const { data: identity, scopes } = await slackRead(this.fetcher, user.access_token, "auth.test");
      if (identity.user_id !== user.id || identity.team_id !== data.team?.id || identity.bot_id) throw new HouseholdError("Slack authorization identity mismatch");
      if (this.pending.get(state) !== p) throw new HouseholdError("Slack connection was cancelled; start again");
      this.save(p.house, p.pets, user.access_token, identity, scopes, { refreshToken: typeof user.refresh_token === "string" ? user.refresh_token : undefined, expiresAt: this.expiry(user.expires_in), clientId: this.clientId }, p.allowWrite);
      return p.house;
    } catch (error) {
      if (error instanceof HouseholdError) throw error;
      throw new HouseholdError("Slack sign-in failed; retry from Connectors");
    } finally { this.pending.delete(state); }
  }
  private expiry(seconds: unknown) {
    if (seconds === undefined) return undefined;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) throw new HouseholdError("Invalid Slack token lifetime");
    return this.now() + seconds * 1000;
  }
  private save(house: string, pets: string[], token: string, data: any, scopes: string[], rotation: Pick<Connection, "refreshToken" | "expiresAt" | "clientId"> = {}, allowWrite = false) {
    this.pets(house, pets);
    if (!/^T[A-Z0-9]+$/.test(data.team_id ?? "") || !/^[UW][A-Z0-9]+$/.test(data.user_id ?? "") || data.bot_id) throw new HouseholdError("Use a user token, not a Slack bot token");
    if (!scopes.length || scopes.some(s => ![...SLACK_READ_SCOPES, "identify", "chat:write"].includes(s))) throw new HouseholdError("Use a dedicated token with only the documented Slack connector scopes");
    const items = this.read(), old = items.find(c => c.house === house && c.teamId === data.team_id && c.userId === data.user_id);
    if (old) this.abort(old.id);
    const c: Connection = { id: randomUUID(), house, token, allowWrite, teamId: data.team_id, team: typeof data.team === "string" ? data.team : data.team_id, userId: data.user_id, user: typeof data.user === "string" ? data.user : data.user_id, scopes, pets, connectedAt: new Date(this.now()).toISOString(), needsReconnect: false, ...rotation };
    this.write([...items.filter(i => i !== old), c]); return this.view(c);
  }
  async connect(house: string, input: unknown) {
    const parsed = slackConnectSchema.safeParse(input);
    if (!parsed.success) throw new HouseholdError("Enter a Slack User OAuth Token (xoxp-) and select bots");
    const pets = this.pets(house, parsed.data.pets), generation = this.generation;
    try {
      const { data, scopes } = await slackRead(this.fetcher, parsed.data.token, "auth.test");
      if (generation !== this.generation) throw new HouseholdError("Workspace changed during connection; try again");
      return this.save(house, pets, parsed.data.token, data, scopes, {}, parsed.data.allowWrite);
    } catch (error) {
      if (error instanceof HouseholdError) throw error;
      throw new HouseholdError(error instanceof SlackReadError ? error.message : "Slack connection failed; check the user token and try again");
    }
  }
  setPets(house: string, id: string, pets: string[]) {
    const allowed = this.pets(house, pets), items = this.read();
    const c = items.find(c => c.house === house && c.id === id);
    if (!c) throw new HouseholdError("Connection not found");
    c.pets = allowed; this.write(items); this.abort(id); return this.view(c);
  }
  private abort(id: string) { this.active.get(id)?.abort(); this.active.delete(id); }
  disconnect(house: string, id: string) {
    this.house(house);
    const items = this.read();
    if (!items.some(c => c.house === house && c.id === id)) throw new HouseholdError("Connection not found");
    this.abort(id); this.write(items.filter(c => c.house !== house || c.id !== id));
  }
  private parent(caller: PetIdentity): string | undefined {
    const house = this.houses.find(h => h.name === caller.house), pet = house?.pets.find(p => p.name === caller.pet);
    if (!pet || pet.scout || pet.enabled === false) return;
    return (pet.sideworker ? house?.pets.find(p => p.name === pet.sideworker!.parent && !p.sideworker && !p.scout && p.enabled !== false) : pet)?.name;
  }
  available(caller: PetIdentity) { return this.parent(caller) !== undefined; }
  accounts(caller: PetIdentity) {
    const parent = this.parent(caller);
    return parent ? this.read().filter(c => c.house === caller.house && c.pets.includes(parent)).map(c => this.view(c)) : [];
  }
  catalog(caller: PetIdentity) { return slackCatalog([...new Set(this.accounts(caller).flatMap(c => c.scopes.filter(s => s !== "chat:write" || c.allowWrite)))]); }
  private allowed(caller: PetIdentity, id: string) {
    const parent = this.parent(caller), c = parent && this.read().find(c => c.house === caller.house && c.id === id && c.pets.includes(parent));
    if (!c) throw new HouseholdError("Slack connection unavailable to this bot");
    if (c.needsReconnect) throw new HouseholdError("Reconnect Slack in this workspace's Connectors page");
    return c;
  }
  private async access(c: Connection): Promise<string> {
    if (!c.expiresAt || c.expiresAt > this.now() + 60_000) return c.token;
    if (!c.refreshToken || !c.clientId) throw new SlackReadError("token_expired");
    if (this.refreshes.has(c.id)) return this.refreshes.get(c.id)!;
    const refresh = (async () => {
      const { data } = await slackOAuth(this.fetcher, { client_id: c.clientId!, grant_type: "refresh_token", refresh_token: c.refreshToken! });
      if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || data.token_type !== "user") throw new SlackReadError("invalid_refresh_token");
      const items = this.read(), current = items.find(i => i.id === c.id);
      if (!current) throw new HouseholdError("Slack connection was removed");
      current.token = data.access_token; current.refreshToken = data.refresh_token; current.expiresAt = this.expiry(data.expires_in);
      if (!current.expiresAt) throw new SlackReadError("invalid_refresh_token");
      this.write(items); return current.token;
    })();
    this.refreshes.set(c.id, refresh);
    try { return await refresh; } finally { this.refreshes.delete(c.id); }
  }
  async request(caller: PetIdentity, id: string, operation: string, params: unknown, signal?: AbortSignal) {
    const c = this.allowed(caller, id), parsed = slackOperation(operation, params);
    if (parsed.spec.write && !c.allowWrite) throw new HouseholdError("Message sending is disabled for this Slack connection");
    if (!parsed.spec.scopes.some(s => c.scopes.includes(s))) throw new HouseholdError("Slack token lacks the required scope; reconnect with the requested permissions");
    const key = `${caller.house}/${caller.pet}`;
    if (!this.budgets.has(key)) this.budgets.set(key, new TokenBucket(1, 10));
    if (!this.budgets.get(key)!.take()) throw new HouseholdError("Too many Slack requests; retry shortly");
    if (!this.active.has(id)) this.active.set(id, new AbortController());
    const controller = this.active.get(id)!;
    try {
      const token = await this.access(c);
      if (controller.signal.aborted) throw new Error("cancelled");
      this.allowed(caller, id);
      const { data } = await (parsed.spec.write ? slackWrite : slackRead)(this.fetcher, token, operation, parsed.params, AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]));
      if (controller.signal.aborted) throw new Error("cancelled");
      this.allowed(caller, id);
      return { trust: "external", data };
    } catch (error) {
      if (error instanceof SlackReadError && ["invalid_grant", "invalid_refresh_token", "invalid_auth", "token_revoked", "token_expired", "account_inactive", "not_authed"].includes(error.reason)) {
        const items = this.read(), current = items.find(i => i.id === id && i.house === caller.house);
        if (current) { current.needsReconnect = true; this.write(items); }
      }
      if (error instanceof HouseholdError) throw error;
      throw new HouseholdError(error instanceof SlackReadError ? error.message : parsed.spec.write ? "Slack send outcome is unknown; check conversation history before retrying" : "Slack request failed or was cancelled; retry shortly");
    }
  }
  stop() { this.generation++; this.pending.clear(); for (const id of this.active.keys()) this.abort(id); }
}
