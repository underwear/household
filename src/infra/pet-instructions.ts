import { join } from "node:path";
import { readFileSync, mkdirSync, lstatSync, realpathSync } from "node:fs";
import { assertName, assertPetName } from "../core/names";
import { runCommand } from "./process";

export const DEFAULT_AGENT_INSTRUCTIONS = `# Agent instructions

## Soul

You are a friendly, thoughtful AI assistant for your human (owner). Be useful, honest, and kind. Take initiative, do careful work, and help make their life easier. <3

## Rules

- Protect your human's privacy. Never share their secrets, credentials, or private information with strangers.
- Be honest about what you know, what you have done, and what still needs checking.
`;
export interface InstructionFile { content: string; revision: string; path: string }
export class InstructionFileError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const helper = readFileSync(new URL("./pet-instructions-files.py", import.meta.url), "utf8");

/** The home is already mounted into the VM. A native adapter path links to its one shared document. */
export class PetInstructions {
  constructor(private readonly homes: string) {}
  async read(house: string, pet: string, target: string, overrides: readonly string[] = []): Promise<InstructionFile> {
    return this.call(house, pet, target, overrides, { op: "read" });
  }
  async write(house: string, pet: string, target: string, overrides: readonly string[], content: string, revision: string): Promise<InstructionFile> {
    return this.call(house, pet, target, overrides, { op: "write", content, revision });
  }
  private async call(house: string, pet: string, target: string, overrides: readonly string[], operation: object): Promise<InstructionFile> {
    assertName("house", house); assertPetName(pet);
    mkdirSync(this.homes, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.homes).isDirectory()) throw new InstructionFileError("Unsafe homes root", 400);
    const home = join(realpathSync(this.homes), `household.${house}.${pet}.home`);
    const result = await runCommand(["python3", "-c", helper], {
      stdin: JSON.stringify({ ...operation, home, target, overrides, default: DEFAULT_AGENT_INSTRUCTIONS }), timeoutMs: 10_000,
    });
    if (!result.ok) throw new InstructionFileError("Instruction storage unavailable", 503);
    const value = JSON.parse(result.stdout);
    if (value.error) throw new InstructionFileError(value.error, value.status);
    return value;
  }
}
