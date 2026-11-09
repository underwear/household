import type { EnvironmentPhase } from "../core/environment";
import { findHouse } from "../core/household";
import type { ConfigStore } from "../infra/config-store";
import { NotFoundError } from "../infra/config-store";
import type { EnvironmentSetupResult } from "../infra/environment-setup";

/** A narrow view of one pet's saved environment; never includes keys or other config. */
export interface EnvironmentView {
  setup: string | null;
  onStart?: string | null;
  onStartLastRun?: EnvironmentSetupResult | null;
  lastRun: EnvironmentSetupResult | null;
}

export interface RestartNotice { text: string; timeoutMs: number }

export interface PetEnvironment {
  getEnvironment(house: string, pet: string): Promise<EnvironmentView>;
  updateEnvironment(house: string, pet: string, fields: { setup?: string | null; onStart?: string | null }): Promise<EnvironmentView>;
  runEnvironmentSetup(house: string, pet: string, phase?: EnvironmentPhase): Promise<EnvironmentSetupResult>;
  disableEnvironment?(house: string, pet: string, mode?: "now" | "notify"): Promise<void>;
  /** `notice`: in notify mode, what the agent is told and how long it has (a scheduled restart's); the defaults otherwise. */
  restartEnvironment(house: string, pet: string, mode?: "now" | "notify", notice?: RestartNotice): Promise<EnvironmentView>;
}

export function petEnvironment(config: ConfigStore, runtime: {
  environmentSetupResult(house: string, pet: string, phase?: EnvironmentPhase): EnvironmentSetupResult | undefined;
  runEnvironmentSetup(house: string, pet: string, setup?: string, phase?: EnvironmentPhase): Promise<EnvironmentSetupResult>;
}, enqueue: <T>(job: () => Promise<T>) => Promise<T>, applied: (house: string, pet: string) => boolean, restart?: (house: string, pet: string, setup?: string, onStart?: string) => Promise<void>, prepareRestart?: (house: string, pet: string, action?: "restart" | "disable", notice?: RestartNotice) => Promise<() => void>, disable?: (house: string, pet: string) => Promise<void>, scriptOwner: (house: string, pet: string) => string = (_house, pet) => pet): PetEnvironment {
  const restarting = new Set<string>();
  const saved = async (house: string, pet: string) => {
    const found = findHouse(await config.load(), house)?.pets.find((item) => item.name === scriptOwner(house, pet));
    if (!found) throw new NotFoundError("bot is no longer configured");
    return found.environment;
  };
  const view = (house: string, pet: string, scripts?: { setup?: string; onStart?: string }): EnvironmentView => ({ setup: scripts?.setup ?? null, onStart: scripts?.onStart ?? null, lastRun: runtime.environmentSetupResult(house, pet) ?? null, onStartLastRun: runtime.environmentSetupResult(house, pet, "onStart") ?? null });
  return {
    async getEnvironment(house, pet) { return view(house, pet, await saved(house, pet)); },
    updateEnvironment(house, pet, fields) {
      if (scriptOwner(house, pet) !== pet) return Promise.reject(new Error("Sideworkers inherit environment scripts; ask the parent to update them"));
      return enqueue(async () => {
        const household = await config.updatePetEnvironment(house, pet, fields);
        const setup = findHouse(household, house)!.pets.find((item) => item.name === pet)!.environment;
        return view(house, pet, setup);
      });
    },
    async restartEnvironment(house, pet, mode = "now", notice) {
      const key = `${house}/${pet}`;
      if (restarting.has(key)) throw new Error("bot is already restarting");
      restarting.add(key);
      let release: (() => void) | undefined;
      try {
        await saved(house, pet);
        if (!applied(house, pet)) throw new Error("bot is no longer applied");
        if (!restart) throw new Error("VM restart is unavailable");
        if (mode === "notify") {
          if (!prepareRestart) throw new Error("restart notification is unavailable");
          // Agent tools may need the lifecycle queue while saving; never hold it during the grace period.
          release = await prepareRestart(house, pet, "restart", notice);
        }
        return await enqueue(async () => {
          const setup = await saved(house, pet);
          if (!applied(house, pet)) throw new Error("bot is no longer applied");
          await restart(house, pet, setup?.setup, setup?.onStart);
          return view(house, pet, setup);
        });
      } finally {
        release?.();
        restarting.delete(key);
      }
    },
    async disableEnvironment(house, pet, mode = "now") {
      const key = `${house}/${pet}`;
      if (restarting.has(key)) throw new Error("bot is already stopping or restarting");
      restarting.add(key);
      let release: (() => void) | undefined;
      try {
        await saved(house, pet);
        if (!disable) throw new Error("VM disable is unavailable");
        if (mode === "notify" && applied(house, pet)) {
          if (!prepareRestart) throw new Error("shutdown notification is unavailable");
          release = await prepareRestart(house, pet, "disable");
        }
        // The disable callback owns its reload queue; never hold it while notifying the agent.
        await disable(house, pet);
      } finally { release?.(); restarting.delete(key); }
    },
    runEnvironmentSetup(house, pet, phase = "setup") {
      return enqueue(async () => {
        const setup = await saved(house, pet);
        if (!applied(house, pet)) throw new Error("bot is no longer applied");
        return runtime.runEnvironmentSetup(house, pet, setup?.[phase], phase);
      });
    },
  };
}
