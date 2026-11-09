/** A bot container's Docker state as a colour (the design's tones) and a word. */
export function petState(state: string): { tone: "idle" | "busy" | "danger" | "off"; label: string } {
  if (state === "disabled") return { tone: "off", label: "Disabled" };
  if (state === "running") return { tone: "idle", label: "Running" };
  if (state === "missing") return { tone: "off", label: "Not started" };
  if (state === "exited" || state === "dead") return { tone: "danger", label: "Stopped" };
  return { tone: "busy", label: state.charAt(0).toUpperCase() + state.slice(1) };
}

type Bot = { name: string; sideworker?: { parent: string } };

/** A workspace's own bots, without the sideworkers they started. */
export const ownBots = <P extends Bot>(pets: P[]) => pets.filter((pet) => !pet.sideworker);

/** The sideworkers a bot started. */
export const workersOf = <P extends Bot>(pets: P[], parent: string) => pets.filter((pet) => pet.sideworker?.parent === parent);

/** Each bot, then the sideworkers it started (a worker whose parent is gone, last): how lists nest them. */
export const withWorkers = <P extends Bot>(pets: P[]) => [
  ...ownBots(pets).flatMap((pet) => [pet, ...workersOf(pets, pet.name)]),
  ...pets.filter((pet) => pet.sideworker && !pets.some((each) => each.name === pet.sideworker!.parent)),
];

/** "2 sideworkers", or nothing for none. */
export const workerCount = (n: number) => (n === 0 ? undefined : `${n} sideworker${n === 1 ? "" : "s"}`);
