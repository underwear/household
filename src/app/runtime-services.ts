import { PetInstructions } from "../infra/pet-instructions";
import { HouseSkills, houseSkillsRoot } from "../infra/house-skills";
import { join } from "node:path";
import { DockerCli } from "../infra/docker-cli";
import { releasedImageFor } from "./agent-images";
import { MicrosandboxRuntime } from "../infra/microsandbox-runtime";
import { PetTokenRegistry } from "../infra/pet-token-registry";
import type { Paths } from "../infra/paths";
import { tlsFiles } from "../infra/certificates";
import { gatewayPorts } from "../infra/gateway-ports";
import { HostNetworkPlane } from "./host-network-plane";
import { instanceId, PetPlane } from "./pet-plane";

export const homesDirectory = (paths: Paths) => join(paths.stateDir, "homes");
export function microvmRuntime(paths: Paths) {
  const ports = gatewayPorts(paths.stateDir);
  return new MicrosandboxRuntime({
    builder: new DockerCli(), released: (tag, contextDir) => releasedImageFor(tag, contextDir),
    homesDir: homesDirectory(paths), proxyPort: ports.proxy, relayPort: ports.relay,
  });
}

/** The pets' microVMs, the host-side egress gateway they reach through, and the plane that runs them. */
export function runtimeServices(paths: Paths) {
  const tokens = new PetTokenRegistry(join(paths.stateDir, "pet-tokens.json"));
  // One choice for the gateway's listeners, the VMs' net rules and the pets' proxy and relay URLs.
  const ports = gatewayPorts(paths.stateDir);
  const runtime = microvmRuntime(paths);
  const network = new HostNetworkPlane({ tlsDir: paths.tlsDir, gatewaySecretsDir: paths.gatewaySecretsDir, tokens, proxyPort: ports.proxy, relayPort: ports.relay });
  const transport = {
    host: runtime.host, proxyPort: ports.proxy, relayPort: ports.relay,
    tokenFor: (pet: { house: string; pet: string }) => tokens.tokenFor(pet),
  };
  return { runtime, network, pets: new PetPlane(runtime, tlsFiles(paths.tlsDir).caCert, instanceId(paths.stateDir), 60_000, transport, new HouseSkills(houseSkillsRoot(paths.stateDir)), new PetInstructions(homesDirectory(paths))) };
}
