import { existsSync, readFileSync } from "node:fs";
import type { Server, Socket } from "node:net";
import { join } from "node:path";
import { openUntil, type Identify, type PetIdentity } from "../core/egress";
import type { Endpoint, Reach } from "../core/network-policy";
import { ensureCertificates } from "../infra/certificates";
import { startInterceptor, type Interceptor, type InterceptorOptions } from "../infra/mitm-server";
import type { PetTokenRegistry } from "../infra/pet-token-registry";
import { identifyPet, type GatewayPolicy } from "../infra/gateway-policy";
import { startProxy, type ProxyLogEntry, type ProxyTimeouts } from "../infra/proxy-server";
import { ownAddresses, type Resolve } from "../infra/public-resolve";
import { startRelay } from "../infra/relay-server";
import { pruneSecrets, writeSecrets } from "../infra/secrets";
import { AGENT_API_SECRET, petCredentials } from "./gateway";
import type { AgentApiAccess, PetKeys, SubjectSpec } from "./gateway";

export interface HostNetworkPlaneOptions {
  /** Host-owned TLS CA and live credential files; neither is mounted into a pet. */
  tlsDir: string;
  gatewaySecretsDir: string;
  /** Shared with pet creation: raw tokens stay outside the policy; only their hashes are published. */
  tokens: Pick<PetTokenRegistry, "entries">;
  host?: string;
  /** This instance's own ports (`gatewayPorts`), the ones its pets' VMs may reach; 0 (tests): any free one. */
  proxyPort: number;
  relayPort: number;
  /** Host name the VM runtime exposes to its guest. */
  guestHost?: string;
  ownAddresses?: () => string[];
  resolve?: Resolve;
  timeouts?: Partial<ProxyTimeouts>;
  bodyDeadlineMs?: number;
  maxOpenPerPet?: number;
  /** Test upstream's CA only; the host normally uses the system trust store. */
  upstreamCa?: string;
}

/** Host subjects have no Docker network or source CIDR: every request identifies its pet by a House token. */
export type HostSubjectStatus = SubjectSpec;

/** The allowance meter's seams on intercepted requests (`InterceptorOptions`): asked before, told after. */
export type Meter = Pick<InterceptorOptions, "guard" | "observe">;

interface Snapshot {
  policy: GatewayPolicy;
  interceptor?: Interceptor;
  certificate?: string;
}

interface Tunnel {
  hash: string;
  pet: PetIdentity;
  target: Endpoint;
  /** How far it went: by name (`any`), or to the one address checked (`pinned`). */
  opened: Reach;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * The host's proxy, credential interceptor and agent relay. Reconciliation stages TLS first, then publishes
 * credentials and policy in one JS turn. Policy and identity are read on each CONNECT/relay request; the
 * interceptor reads the current pet's credential rules and secret file on every request, including refreshes.
 */
export class HostNetworkPlane {
  private snapshot: Snapshot = { policy: { rules: [], tokens: [] } };
  private proxy?: Server;
  private relay?: ReturnType<typeof startRelay>;
  private readonly sockets = new Set<Socket>();
  private readonly capabilities = new Map<Socket, Tunnel>();
  private readonly draining = new Set<Interceptor>();
  private stopped = false;
  /** Where each connection and intercepted request is told, as `reset` was given it. */
  private log: (entry: ProxyLogEntry) => void = () => {};
  private meter: Meter = {};

  constructor(private readonly options: HostNetworkPlaneOptions) {}

  get proxyPort(): number {
    const address = this.proxy?.address();
    if (!address || typeof address === "string") throw new Error("the host proxy is not listening");
    return address.port;
  }

  get relayPort(): number {
    if (!this.relay?.port) throw new Error("the host relay is not listening");
    return this.relay.port;
  }

  get proxyUrl(): string { return `http://${this.options.guestHost ?? "host.microsandbox.internal"}:${this.proxyPort}`; }
  get relayUrl(): string { return `http://${this.options.guestHost ?? "host.microsandbox.internal"}:${this.relayPort}`; }

  /** The rules in force, as published (secret values are files, never in it): what `status` and tests look at. */
  get policy(): GatewayPolicy { return structuredClone(this.snapshot.policy); }

  /**
   * Bind only to loopback by default. Empty policy denies every pet until reconciliation publishes tokens. Every
   * connection and intercepted request goes to `log` (the daemon's event log), as it happens.
   */
  async reset(log: (entry: ProxyLogEntry) => void, meter: Meter = {}): Promise<void> {
    await this.stop();
    this.stopped = false;
    this.log = log;
    this.meter = meter;
    await ensureCertificates(this.options.tlsDir, []);
    const plane = this;
    const identify: Identify = (caller) => identifyPet(this.snapshot.policy, caller);
    try {
      this.proxy = await startProxy({
        host: this.options.host ?? "127.0.0.1",
        port: this.options.proxyPort,
        rules: () => this.snapshot.policy.rules,
        identify,
        identified: (socket, pet, target, opened) => {
          const hash = this.snapshot.policy.tokens?.find((entry) => entry.house === pet.house && entry.pet === pet.pet)?.sha256;
          if (!hash) return void socket.destroy();
          const tunnel: Tunnel = { hash, pet, target, opened };
          this.capabilities.set(socket, tunnel);
          this.enforce(socket, tunnel);
          socket.once("close", () => { clearTimeout(tunnel.timer); this.capabilities.delete(socket); });
        },
        // Read once per judgment: a tunnel retains the concrete TLS listener it was directed to.
        get interceptor() { return plane.snapshot.interceptor; },
        log: (entry) => this.log(entry),
        resolve: this.options.resolve,
        ownAddresses: this.options.ownAddresses ?? ownAddresses,
        timeouts: this.options.timeouts,
      });
      this.proxy.on("connection", (socket) => {
        this.sockets.add(socket);
        socket.once("close", () => this.sockets.delete(socket));
      });
      this.relay = startRelay({
        host: this.options.host ?? "127.0.0.1",
        port: this.options.relayPort,
        policy: () => this.snapshot.policy,
        identify,
        secret: () => this.readSecret(AGENT_API_SECRET),
        bodyDeadlineMs: this.options.bodyDeadlineMs,
        maxOpenPerPet: this.options.maxOpenPerPet,
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** No Docker work, file policy handoff or signal: the new table becomes visible as one pointer swap. */
  async reconcile(specs: SubjectSpec[], keys: PetKeys, access: AgentApiAccess): Promise<{ subjects: HostSubjectStatus[] }> {
    if (!this.proxy || !this.relay || this.stopped) throw new Error("reset the host network plane before reconciling it");
    const subjects = structuredClone(specs);
    const hosts = [...new Set(subjects.flatMap(({ intercept }) => intercept.map(({ host }) => host)))];
    const before = this.snapshot;
    const { files } = await ensureCertificates(this.options.tlsDir, hosts);
    if (this.stopped) throw new Error("the host network plane is stopping");
    let interceptor = before.interceptor;
    let created: Interceptor | undefined;
    const certificate = hosts.length > 0 ? readFileSync(files.leafCert, "utf8") : undefined;
    if (hosts.length === 0) interceptor = undefined;
    else if (certificate !== before.certificate || !interceptor) {
      created = startInterceptor({
        cert: certificate!, key: readFileSync(files.leafKey, "utf8"),
        credentials: (pet, target) => petCredentials(this.snapshot.policy, pet, target),
        readSecret: (name) => this.readSecret(name),
        log: (entry) => this.log(entry),
        upstreamCa: this.options.upstreamCa,
        // Read through to the meter on every request: the one the daemon gave at reset, whatever interceptor is live.
        guard: (pet, target) => this.meter.guard?.(pet, target),
        observe: (pet, target, headers) => this.meter.observe?.(pet, target, headers),
      });
      interceptor = created;
    }
    try {
      const policy: GatewayPolicy = {
        rules: structuredClone(subjects), tokens: this.options.tokens.entries(keys.pets.map(({ house, pet }) => ({ house, pet }))),
        keys: structuredClone(keys.pets), agentApi: access.url,
      };
      const values = { ...keys.secrets, [AGENT_API_SECRET]: access.secret };
      // No await between writing the live secret files and publishing rules: requests cannot see half a table.
      writeSecrets(this.options.gatewaySecretsDir, values);
      pruneSecrets(this.options.gatewaySecretsDir, Object.keys(values));
      this.snapshot = { policy, interceptor, certificate };
      const allowed = new Set(policy.tokens!.map(({ sha256 }) => sha256));
      for (const [socket, tunnel] of this.capabilities) {
        if (!allowed.has(tunnel.hash)) socket.destroy();
        else this.enforce(socket, tunnel);
      }
    } catch (error) {
      created?.stop();
      // A partial credential-file write must never leave the previous rules using a different key.
      this.snapshot = { ...before, policy: { ...before.policy, keys: [] } };
      throw error;
    }
    if (before.interceptor && before.interceptor !== interceptor) this.retire(before.interceptor);
    return { subjects };
  }

  /** Deny new work before closing listeners and tunnels. Credential files persist for the daemon's refresher. */
  async stop(): Promise<void> {
    this.stopped = true;
    const interceptor = this.snapshot.interceptor;
    this.snapshot = { policy: { rules: [], tokens: [] } };
    const proxy = this.proxy;
    const relay = this.relay;
    this.proxy = undefined;
    this.relay = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const tunnel of this.capabilities.values()) clearTimeout(tunnel.timer);
    this.capabilities.clear();
    const closed = proxy ? new Promise<void>((resolve) => proxy.close(() => resolve())) : Promise.resolve();
    await Promise.all([closed, relay?.stop(true), interceptor?.stop(), ...[...this.draining].map((old) => old.stop())]);
    this.draining.clear();
  }

  private readSecret(name: string): string | undefined {
    const path = join(this.options.gatewaySecretsDir, name);
    return (existsSync(path) && readFileSync(path, "utf8").trim()) || undefined;
  }

  private retire(interceptor: Interceptor): void {
    this.draining.add(interceptor);
    // Stop accepting new TLS tunnels while already streaming responses finish normally.
    void Promise.resolve(interceptor.stop(false)).then(() => this.draining.delete(interceptor), () => {});
  }

  /**
   * The pet's rules as they are now judge its open tunnel again: one they no longer allow as far as it went (a grant
   * revoked or expired, an exact entry gone where only a wildcard remains) closes. A grant's deadline closes it too;
   * no daemon reload or queued runtime job can extend it.
   */
  private enforce(socket: Socket, tunnel: Tunnel): void {
    clearTimeout(tunnel.timer);
    const now = Date.now();
    const until = openUntil(this.snapshot.policy.rules, tunnel.pet, tunnel.target, tunnel.opened, now);
    if (until === undefined) return void socket.destroy();
    if (Number.isFinite(until)) tunnel.timer = setTimeout(() => this.enforce(socket, tunnel), Math.max(0, Math.min(until - now, 2_147_483_647)));
  }
}
