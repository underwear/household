import { connectorCallers, connectorWritePolicy, connectorWritePolicySchema, type ConnectorWritePolicy } from "../core/connector-write-policy";
import type { ConnectorWrites } from "./connector-writes";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { googleConnectSchema, GOOGLE_SCOPES, GOOGLE_WRITE_SCOPES, type GoogleConnectionView, type GoogleService } from "../core/google-connectors";
import type { House } from "../core/household";
import { HouseholdError } from "../core/errors";
import type { PetIdentity } from "../infra/agent-api";
import type { KeyValueStore } from "../infra/sqlite-store";
import { boundedBytes, boundedText, googleClient, googleJson, GoogleHttpError, MAX_DRIVE_FILE_BYTES, type GoogleFetch } from "../infra/google/client";
import { decodeMail, DRIVE_EXPORTS, googleRequest, operationCatalog } from "../infra/google/operations";
import { TokenBucket } from "./token-bucket";

const KEY = "house.connectors.google.v1";
interface Connection extends GoogleConnectionView { house: string; subject: string; accessToken: string; refreshToken: string; expiresAt: number }
interface Pending { consumed?: boolean; house: string; services: GoogleService[]; write: boolean; writePolicy: ConnectorWritePolicy; pets: string[]; verifier: string; redirect: string; binding: string; expires: number }
/** The pet's home as Drive transfers see it: uploads read its outbox, downloads land in its inbox. */
export interface GoogleFiles {
  read(caller: PetIdentity, path: string, maxBytes: number): Promise<Uint8Array>;
  save(caller: PetIdentity, name: string, bytes: Uint8Array): Promise<string>;
}
type Call = (target: URL, init?: RequestInit) => Promise<Response>;
const MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", tif: "image/tiff", tiff: "image/tiff",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html", json: "application/json", xml: "application/xml",
  doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet", zip: "application/zip",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", mp4: "video/mp4", mov: "video/quicktime",
};
const mediaTypeOf = (name: string) => MEDIA_TYPES[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";
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
  constructor(private store: KeyValueStore, private client = googleClient(), private fetcher: GoogleFetch = fetch, private now = Date.now, private writes?: ConnectorWrites, private files?: GoogleFiles) {}
  private read(): Connection[] { return JSON.parse(this.store.get(KEY) ?? "[]"); }
  private write(items: Connection[]) { this.store.set(KEY, JSON.stringify(items)); }
  private view(c: Connection): GoogleConnectionView {
    return { writePolicy: connectorWritePolicy(c.writePolicy, !!c.writable?.length), id: c.id, email: c.email, services: [...c.services], writable: [...(c.writable ?? [])], pets: [...c.pets], connectedAt: c.connectedAt, needsReconnect: c.needsReconnect };
  }
  setHouses(houses: House[]) {
    const beforeCallers = new Map(this.read().map(c => [c.id, connectorCallers(this.houses, c.house, c.pets)]));
    this.houses = structuredClone(houses);
    const saved = this.read();
    const kept = saved.filter(c => houses.some(h => h.name === c.house));
    for (const c of saved) if (!kept.includes(c)) this.abort(c.id);
    for (const c of kept) c.pets = c.pets.filter(p => houses.find(h => h.name === c.house)?.pets.some(pet => pet.name === p && !pet.sideworker && !pet.scout));
    for (const c of kept) {
      const after = connectorCallers(houses, c.house, c.pets);
      if (beforeCallers.get(c.id)?.some(name => !after.includes(name))) this.abort(c.id);
    }
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
    const writePolicy = connectorWritePolicy(parsed.data.writePolicy, parsed.data.write);
    if (!this.client.id || !this.client.secret) throw new HouseholdError("Google OAuth is not configured in this build");
    const base = new URL(origin);
    if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname) || base.username || base.password) throw new HouseholdError("Connect Google from the local Household dashboard");
    for (const [key, p] of this.pending) if (p.expires <= this.now()) this.pending.delete(key);
    if (this.pending.size >= 20) throw new HouseholdError("Too many pending connections; retry in ten minutes");
    const state = nonce(), verifier = nonce();
    const services = [...new Set(parsed.data.services)];
    const redirect = `${base.origin}/api/connectors/google/callback`;
    this.pending.set(state, { house, services, write: writePolicy !== "disabled", writePolicy, pets, verifier, redirect, binding, expires: this.now() + 600_000 });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: this.client.id, redirect_uri: redirect, response_type: "code", scope: scopesFor(services, writePolicy !== "disabled").join(" "), state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", access_type: "offline", prompt: "consent select_account" }).toString();
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
      const c: Connection = { id: randomUUID(), house: p.house, subject: identity.sub, email: identity.email, services, writable, pets: p.pets, writePolicy: p.writePolicy, connectedAt: new Date(this.now()).toISOString(), accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: this.expiry(tokens.expires_in), needsReconnect: false };
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
  setPets(house: string, id: string, pets: string[], policy?: ConnectorWritePolicy) {
    const allowed = this.pets(house, pets), items = this.read();
    const c = items.find(c => c.house === house && c.id === id);
    if (!c) throw new HouseholdError("Connection not found");
    if (policy !== undefined) c.writePolicy = connectorWritePolicySchema.parse(policy);
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
    return operationCatalog([...new Set(accounts.flatMap(c => c.services))], [...new Set(accounts.flatMap(c => c.writePolicy === "disabled" ? [] : c.writable))]);
  }
  private allowed(caller: PetIdentity, id: string, service: GoogleService, write = false) {
    const parent = this.parent(caller);
    const c = parent && this.read().find(c => c.id === id && c.house === caller.house && c.pets.includes(parent) && c.services.includes(service));
    if (!c) throw new HouseholdError("Google connection or service unavailable to this bot");
    if (write && (!c.writable?.includes(service) || connectorWritePolicy(c.writePolicy, !!c.writable?.length) === "disabled")) throw new HouseholdError(`This account's ${service} is read only; the owner can reconnect it with Ask me first or Full access on the workspace's Connectors page`);
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
  async request(caller: PetIdentity, id: string, operation: string, params: unknown, signal?: AbortSignal, clientRequestId?: string) {
    const { url, spec, init, params: review } = googleRequest(operation, params);
    const write = spec.write === true;
    const c = this.allowed(caller, id, spec.service, write);
    if (spec.file && !this.files) throw new HouseholdError("Drive file transfers are unavailable in this Household");
    const budgetKey = `${caller.house}/${caller.pet}`;
    if (!this.budgets.has(budgetKey)) this.budgets.set(budgetKey, new TokenBucket(1, 10));
    if (!this.budgets.get(budgetKey)!.take()) throw new HouseholdError("Too many Google requests; retry shortly");
    // An upload is snapshotted now: the owner approves, and Drive receives, exactly these bytes.
    let file: { bytes: Uint8Array; contentType: string } | undefined, reviewed: unknown = review;
    if (spec.file === "upload") {
      const p = review as { path: string; name?: string; contentType?: string; parents?: string[]; description?: string };
      let bytes: Uint8Array;
      try { bytes = await this.files!.read(caller, p.path, MAX_DRIVE_FILE_BYTES); } catch (error) {
        throw new HouseholdError(`Could not read ~/.household/outbox/${p.path} (${error instanceof Error ? error.message : "unreadable"}); files up to 50 MiB can be uploaded`);
      }
      const name = p.name ?? basename(p.path), contentType = p.contentType ?? mediaTypeOf(name);
      file = { bytes, contentType };
      init.body = JSON.stringify(Object.fromEntries(Object.entries({ name, parents: p.parents, description: p.description }).filter(([, v]) => v !== undefined)));
      reviewed = { ...p, name, contentType, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    if (!this.active.has(id)) this.active.set(id, new AbortController());
    const controller = this.active.get(id)!;
    const execute = async (signal?: AbortSignal) => {
      try {
        const access = await this.access(this.allowed(caller, id, spec.service, write));
        this.allowed(caller, id, spec.service, write);
        controller.signal.throwIfAborted(); signal?.throwIfAborted();
        const limit = AbortSignal.any([controller.signal, AbortSignal.timeout(spec.file ? 300_000 : 30_000), ...(signal ? [signal] : [])]);
        const call: Call = (target, request = {}) => this.fetcher(target, { ...request, headers: { ...request.headers as Record<string, string>, authorization: `Bearer ${access}` }, redirect: "error", signal: limit });
        let data: any, download: Awaited<ReturnType<GoogleConnectors["download"]>> | undefined;
        if (spec.file === "upload") data = await this.upload(call, url, String(init.body), file!);
        else if (spec.file === "download") download = await this.download(call, url, review as { id: string; exportMimeType?: keyof typeof DRIVE_EXPORTS });
        else {
          const response = await call(url, { method: init.method, body: init.body, headers: init.headers as Record<string, string> | undefined });
          if (!response.ok) { await response.body?.cancel(); throw new GoogleHttpError(response.status); }
          const raw = await boundedText(response);
          data = spec.text ? { text: raw } : !raw.trim() ? { done: true } : spec.message ? decodeMail(JSON.parse(raw)) : JSON.parse(raw);
        }
        if (controller.signal.aborted) throw new Error("cancelled");
        // A change went through even if access was revoked meanwhile: say what happened rather than hide it.
        if (!write) this.allowed(caller, id, spec.service);
        if (download) {
          const { bytes, ...meta } = download;
          data = { ...meta, path: await this.files!.save(caller, meta.name, bytes) };
        }
        return { trust: "external", data };
      } catch (error) {
        if (error instanceof HouseholdError) throw error;
        if (error instanceof GoogleHttpError) throw new HouseholdError(`Google returned ${error.status}. Check access, enabled APIs and permissions; reconnect if authorization was revoked.`);
        if (error instanceof Error && error.message.startsWith("Google response too large")) throw new HouseholdError(error.message);
        throw new HouseholdError(write ? "Google write outcome is unknown; inspect the account before trying again" : "Google request failed or was cancelled; retry with a narrower request");
      }
    };
    if (write && (connectorWritePolicy(c.writePolicy, !!c.writable?.length) === "approval" || (clientRequestId !== undefined && this.writes))) {
      if (!this.writes) throw new HouseholdError("Connector approval service is unavailable; nothing changed");
      const requireApproval = connectorWritePolicy(c.writePolicy, !!c.writable?.length) === "approval";
      // A draft ID is mutable. Review its contents, then supply that exact MIME in the send request.
      // Preparation runs after deduplication so a retry of a sent/deleted draft still returns its result.
      const prepare = requireApproval && operation === "gmail.drafts.send" ? async (preparationSignal: AbortSignal) => {
        const access = await this.access(this.allowed(caller, id, "gmail", true));
        this.allowed(caller, id, "gmail", true);
        const draftId = (review as { id: string }).id;
        const read = (format: string) => googleJson(this.fetcher, `https://www.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}?format=${format}`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000), preparationSignal]) });
        const raw = await read("raw"), full = await read("full");
        if (typeof raw.message?.id !== "string" || raw.message.id !== full.message?.id || typeof raw.message.raw !== "string" || !/^[A-Za-z0-9_-]+=*$/.test(raw.message.raw) || !full.message.payload) throw new HouseholdError("The Gmail draft changed or could not be reviewed. Read it again before requesting approval.");
        // Gmail can return text bodies by attachmentId instead of inline data. Metadata is not a preview.
        const completeText = (part: any): boolean => (!(typeof part.mimeType === "string" && part.mimeType.startsWith("text/")) || (typeof part.body?.data === "string" && part.body.data.length > 0) || part.body?.size === 0) && (!Array.isArray(part.parts) || part.parts.every(completeText));
        if (!completeText(full.message.payload)) throw new HouseholdError("The Gmail draft text could not be fully reviewed. Send explicitly supplied message text instead; nothing was sent.");
        init.body = JSON.stringify({ id: draftId, message: { raw: raw.message.raw, ...(raw.message.threadId ? { threadId: raw.message.threadId } : {}) } });
        return { id: draftId, message: decodeMail(full.message) };
      } : undefined;
      return this.writes.run({ caller, provider: "google", connection: id, account: c.email, operation, requireApproval, params: reviewed, prepare, clientRequestId, signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]), validate: () => { this.allowed(caller, id, spec.service, true); }, execute });
    }
    return execute(signal);
  }
  /** Drive's resumable upload: open a session with the metadata, then send the bytes to it. Works for any size. */
  private async upload(call: Call, url: URL, metadata: string, file: { bytes: Uint8Array; contentType: string }) {
    const start = await call(url, { method: "POST", body: metadata, headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": file.contentType, "x-upload-content-length": String(file.bytes.length) } });
    await start.body?.cancel();
    if (!start.ok) throw new GoogleHttpError(start.status);
    // The session must stay on the upload endpoint asked for: a token never goes anywhere a response points.
    const session = new URL(start.headers.get("location") ?? "about:blank");
    if (session.protocol !== "https:" || session.host !== url.host || session.pathname !== url.pathname || session.username || session.password) throw new Error("unexpected upload session");
    const response = await call(session, { method: "PUT", body: new Uint8Array(file.bytes), headers: { "content-type": file.contentType } });
    if (!response.ok) { await response.body?.cancel(); throw new GoogleHttpError(response.status); }
    return JSON.parse(await boundedText(response));
  }
  /** A stored file as is, or a Google Docs, Sheets, Slides or Drawings file exported (PDF by default). */
  private async download(call: Call, url: URL, params: { id: string; exportMimeType?: keyof typeof DRIVE_EXPORTS }) {
    const head = await call(url);
    if (!head.ok) { await head.body?.cancel(); throw new GoogleHttpError(head.status); }
    const meta = JSON.parse(await boundedText(head));
    if (typeof meta.name !== "string" || typeof meta.mimeType !== "string") throw new Error("invalid Drive metadata");
    if (meta.mimeType === "application/vnd.google-apps.folder") throw new HouseholdError("A folder cannot be downloaded; list its files with drive.files.list, q: '<folder id>' in parents");
    const workspace = meta.mimeType.startsWith("application/vnd.google-apps.");
    if (!workspace && params.exportMimeType) throw new HouseholdError("exportMimeType is only for Google Docs, Sheets, Slides and Drawings; omit it to download this file as is");
    if (!workspace && Number(meta.size) > MAX_DRIVE_FILE_BYTES) throw new HouseholdError("This Drive file exceeds 50 MiB, the download limit");
    const exportType = workspace ? params.exportMimeType ?? "application/pdf" : undefined;
    const target = new URL(url); target.search = "";
    if (exportType) { target.pathname += "/export"; target.searchParams.set("mimeType", exportType); }
    else { target.searchParams.set("alt", "media"); target.searchParams.set("supportsAllDrives", "true"); }
    const response = await call(target);
    if (!response.ok) { await response.body?.cancel(); throw new GoogleHttpError(response.status); }
    const bytes = await boundedBytes(response, MAX_DRIVE_FILE_BYTES, "Google response too large: this Drive file exceeds 50 MiB, the download limit");
    const extension = exportType ? DRIVE_EXPORTS[exportType] : undefined;
    let name = meta.name.replace(/[/\\\x00-\x1f]/g, "_").slice(0, 180) || "drive-file";
    if (extension && !name.toLowerCase().endsWith(`.${extension}`)) name = `${name}.${extension}`;
    return { id: typeof meta.id === "string" ? meta.id : params.id, name, mimeType: exportType ?? meta.mimeType, size: bytes.length, bytes };
  }
  stop() { for (const id of this.active.keys()) this.abort(id); this.pending.clear(); }
}
