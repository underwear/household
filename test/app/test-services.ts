import { join } from "node:path";
import { HostNetworkPlane } from "../../src/app/host-network-plane";
import { PetPlane } from "../../src/app/pet-plane";
import type { Paths } from "../../src/infra/paths";
import { PetTokenRegistry } from "../../src/infra/pet-token-registry";
import type { FakeRuntime } from "./fake-runtime";

/** What `runtimeServices` gives the daemon, over a fake VM runtime: the real host gateway, on free ports. */
export function testServices(paths: Paths, runtime: FakeRuntime, readyTimeoutMs = 50) {
  const tokens = new PetTokenRegistry(join(paths.stateDir, "pet-tokens.json"));
  /** A fresh gateway on the same tokens (a second daemon's, say). */
  const network = () => new HostNetworkPlane({ tlsDir: paths.tlsDir, gatewaySecretsDir: paths.gatewaySecretsDir, tokens, guestHost: "127.0.0.1", proxyPort: 0, relayPort: 0 });
  const transport = { host: "127.0.0.1", proxyPort: 3128, relayPort: 8080, tokenFor: (pet: { house: string; pet: string }) => tokens.tokenFor(pet) };
  return { runtime, network, tokens, pets: new PetPlane(runtime, "/ca.crt", "test", readyTimeoutMs, transport) };
}
