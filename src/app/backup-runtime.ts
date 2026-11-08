import { HostHomeStorage } from "../infra/home-storage";
import type { MicrosandboxRuntime } from "../infra/microsandbox-runtime";
import type { StorageRuntime } from "../infra/runtime";
import type { Paths } from "../infra/paths";
import type { BackupDeps } from "./backup";
import { homesDirectory, microvmRuntime } from "./runtime-services";

/** Backups use the same VM lifecycle and host home directories as the daemon. */
export function backupRuntime(paths: Paths, deps: {
  pets?: Pick<MicrosandboxRuntime, "machine" | "pause" | "unpause" | "cancel">;
  homes?: StorageRuntime & { cancel(): void };
} = {}): BackupDeps["runtime"] & { cancel(): void } {
  const pets = deps.pets ?? microvmRuntime(paths);
  const homes = deps.homes ?? new HostHomeStorage(homesDirectory(paths));
  return {
    container: pets.machine.bind(pets),
    pause: pets.pause.bind(pets),
    unpause: pets.unpause.bind(pets),
    volumeHasFiles: homes.volumeHasFiles.bind(homes),
    saveVolume: homes.saveVolume.bind(homes),
    loadVolume: homes.loadVolume.bind(homes),
    cancel: () => { pets.cancel(); homes.cancel(); },
  };
}
