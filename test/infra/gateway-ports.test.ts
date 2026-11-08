import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { freeOnLoopback, gatewayPorts, gatewayPortsFile } from "../../src/infra/gateway-ports";
import { tempDir } from "../helpers";

test("an instance's gateway ports are chosen once, uncommon and distinct, and kept in its state dir", () => {
  const dir = tempDir();
  const ports = gatewayPorts(dir);
  for (const port of [ports.proxy, ports.relay]) {
    expect(port).toBeGreaterThanOrEqual(20_000);
    expect(port).toBeLessThanOrEqual(32_000);
  }
  expect(ports.proxy).not.toBe(ports.relay);
  expect(gatewayPorts(dir)).toEqual(ports);
  expect(JSON.parse(readFileSync(gatewayPortsFile(dir), "utf8"))).toEqual({ version: 1, ...ports });
  expect(statSync(gatewayPortsFile(dir)).mode & 0o777).toBe(0o600);
  // Another instance chooses its own.
  const others = new Set(Array.from({ length: 5 }, () => gatewayPorts(tempDir()).proxy));
  expect(others.size).toBeGreaterThan(1);
});

test("a port something listens on is never chosen; a file without two valid ports is chosen anew", () => {
  const dir = tempDir();
  const tried: number[] = [];
  const ports = gatewayPorts(dir, (port) => { tried.push(port); return tried.length > 2; });
  expect(tried.slice(0, 2)).not.toContain(ports.proxy);
  for (const saved of [{ version: 1, proxy: 3128, relay: 8080 }, { version: 1, proxy: 20_001, relay: 20_001 }, { version: 2, proxy: 20_001, relay: 20_002 }, "not json"]) {
    writeFileSync(gatewayPortsFile(dir), typeof saved === "string" ? saved : JSON.stringify(saved));
    const chosen = gatewayPorts(dir);
    expect(chosen.proxy).toBeGreaterThanOrEqual(20_000);
    expect(chosen.proxy).not.toBe(chosen.relay);
  }
  expect(() => gatewayPorts(tempDir(), () => false)).toThrow("no free port");
});

test("a port held on loopback is not free", async () => {
  const held = net.createServer();
  await new Promise<void>((resolve) => held.listen(0, "127.0.0.1", resolve));
  const port = (held.address() as net.AddressInfo).port;
  try {
    expect(freeOnLoopback(port)).toBe(false);
  } finally {
    await new Promise<void>((resolve) => held.close(() => resolve()));
  }
  expect(freeOnLoopback(port)).toBe(true);
});
