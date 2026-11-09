import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PET_TOKEN_HEADER, type Caller, type PetIdentity, type PetTokenIdentity } from "../core/egress";
import { HouseholdError } from "../core/errors";
import { NAME_PATTERN, PET_NAME_PATTERN } from "../core/names";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const identityKey = ({ house, pet }: PetIdentity) => `${house}/${pet}`;
const validPet = (pet: PetIdentity) => typeof pet.house === "string" && typeof pet.pet === "string" && NAME_PATTERN.test(pet.house) && PET_NAME_PATTERN.test(pet.pet);
export const hashPetToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Strictly parses capability headers; an explicit malformed credential is never an IP identity. */
export function petTokenFrom(caller: Caller): { present: boolean; token?: string } {
  const direct = caller.header(PET_TOKEN_HEADER);
  const proxy = caller.header("proxy-authorization");
  let proxied: string | undefined;
  if (proxy !== undefined) {
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(proxy);
    if (!match) return { present: true };
    const decoded = Buffer.from(match[1]!, "base64");
    if (decoded.toString("base64") !== match[1]) return { present: true };
    const text = decoded.toString("utf8");
    if (!text.startsWith("household:")) return { present: true };
    proxied = text.slice("household:".length);
    if (!TOKEN.test(proxied)) return { present: true };
  }
  if (direct !== undefined && !TOKEN.test(direct)) return { present: true };
  if (direct !== undefined && proxied !== undefined && direct !== proxied) return { present: true };
  const token = direct ?? proxied;
  return token === undefined ? { present: false } : { present: true, token };
}

/** Single daemon writer. Only this host file contains raw capabilities; policy carries their digests. */
export class PetTokenRegistry {
  private readonly pets = new Map<string, { house: string; pet: string; token: string }>();
  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    try {
      if (!lstatSync(path).isFile()) throw new Error();
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.pets)) throw new Error();
      const seen = new Set<string>();
      for (const entry of data.pets) {
        if (!entry || !validPet(entry) || typeof entry.token !== "string" || !TOKEN.test(entry.token) || this.pets.has(identityKey(entry)) || seen.has(entry.token)) throw new Error();
        this.pets.set(identityKey(entry), { house: entry.house, pet: entry.pet, token: entry.token }); seen.add(entry.token);
      }
      chmodSync(path, 0o600);
    } catch { throw new HouseholdError("bot capability registry is invalid; its credentials were not loaded"); }
  }

  tokenFor(identity: PetIdentity): string {
    if (!validPet(identity)) throw new HouseholdError("invalid bot identity for capability registry");
    const key = identityKey(identity);
    const current = this.pets.get(key);
    if (current) return current.token;
    const token = randomBytes(32).toString("base64url");
    this.pets.set(key, { house: identity.house, pet: identity.pet, token }); this.save(); return token;
  }

  /** Publish exactly the wanted identities; removed pets lose their capability permanently. */
  entries(wanted: PetIdentity[]): PetTokenIdentity[] {
    if (!wanted.every(validPet)) throw new HouseholdError("invalid bot identity for capability registry");
    const names = new Set(wanted.map(identityKey));
    let changed = false;
    for (const key of this.pets.keys()) if (!names.has(key)) { this.pets.delete(key); changed = true; }
    const unique = [...new Map(wanted.map(pet => [identityKey(pet), pet])).values()];
    const result = unique.map(identity => ({ house: identity.house, pet: identity.pet, sha256: hashPetToken(this.tokenFor(identity)) }));
    if (changed) this.save();
    return result;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (lstatSync(this.path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new HouseholdError("bot capability registry must be a plain file");
    const tmp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, pets: [...this.pets.values()] }) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, this.path);
  }
}
