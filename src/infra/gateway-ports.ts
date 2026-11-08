import { randomInt } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The host ports of an instance's egress gateway: its proxy and its relay. They are the only host ports its pets'
 * VMs may reach (`--net-rule`), so they are this instance's own, not well-known ones (3128, 8080) that another
 * service of the owner's may hold while Household is stopped.
 */
export interface GatewayPorts {
  proxy: number;
  relay: number;
}

/** Uncommon, below every system's ephemeral range (Linux 32768+, macOS 49152+). */
const RANGE = { min: 20_000, max: 32_000 };
const valid = (port: unknown): port is number => Number.isInteger(port) && (port as number) >= RANGE.min && (port as number) <= RANGE.max;

/** Where an instance keeps its gateway ports, in its state dir. */
export const gatewayPortsFile = (stateDir: string) => join(stateDir, "gateway-ports.json");

/**
 * The instance's gateway ports: chosen once, at random among the free loopback ports of the range, then kept (pets'
 * VMs carry them). A file that does not hold two valid ports is chosen anew: the pets are recreated on them.
 */
export function gatewayPorts(stateDir: string, free: (port: number) => boolean = freeOnLoopback): GatewayPorts {
  const path = gatewayPortsFile(stateDir);
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved?.version === 1 && valid(saved.proxy) && valid(saved.relay) && saved.proxy !== saved.relay) return { proxy: saved.proxy, relay: saved.relay };
  } catch { /* none yet, or unreadable: choose */ }
  const proxy = pick(free, []);
  const ports = { proxy, relay: pick(free, [proxy]) };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("the gateway ports file must be a plain file");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, ...ports }) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  return ports;
}

function pick(free: (port: number) => boolean, taken: number[]): number {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = randomInt(RANGE.min, RANGE.max + 1);
    if (!taken.includes(port) && free(port)) return port;
  }
  throw new Error(`no free port for Household's gateway in ${RANGE.min}–${RANGE.max}`);
}

/** Whether nothing listens on the port on loopback now (what the gateway binds). */
export function freeOnLoopback(port: number): boolean {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
}
