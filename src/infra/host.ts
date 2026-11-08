import { availableParallelism, totalmem } from "node:os";
import type { HostCapacity } from "../core/resources";

/** This machine's CPUs and memory (whole MiB): the most any one pet's VM may be given. */
export const hostCapacity = (): HostCapacity => ({ cpus: availableParallelism(), memoryMiB: Math.floor(totalmem() / 1024 ** 2) });
