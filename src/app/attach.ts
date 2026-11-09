import { HouseholdError } from "../core/errors";
import { findHouse } from "../core/household";
import { ConfigStore } from "../infra/config-store";
import { microvmRuntime } from "./runtime-services";
import type { Paths } from "../infra/paths";
import { DEFAULT_AGENT, knownAgents } from "./agents";
import { petContainer } from "./pet-plane";

/** `house pet attach`: puts the caller's terminal into the pet's agent session. Resolves to the exit code. */
export async function attachPet(paths: Paths, houseName: string, petName: string): Promise<number> {
  const house = findHouse(await new ConfigStore(paths.configFile).load(), houseName);
  if (!house) throw new HouseholdError(`unknown workspace '${houseName}'`);
  const pet = house.pets.find((candidate) => candidate.name === petName);
  if (!pet) throw new HouseholdError(`unknown bot '${petName}' in workspace '${houseName}'`);
  const agent = knownAgents().get(pet.agent ?? DEFAULT_AGENT);
  if (!agent) throw new HouseholdError(`bot ${houseName}/${petName}: unknown harness '${pet.agent}'`);
  if (!agent.attach) throw new HouseholdError(`harness '${agent.name}' has no interactive session`);
  const runtime = microvmRuntime(paths);
  const container = petContainer(houseName, petName);
  if (!(await runtime.isRunning(container))) {
    throw new HouseholdError(`bot ${houseName}/${petName} is not running; start it with \`house start\``);
  }
  return runtime.attach(container, agent.attach);
}
