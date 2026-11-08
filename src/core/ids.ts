import { HouseholdError } from "./errors";

/**
 * Household's ids of the things of a house's chat a pet sees, minted per house and opaque: a one-letter kind and
 * a number (messages `m…`, people `p…`, channels `c…`). Pets see and pass only these; a channel's own ids never
 * stand in for them.
 */
const PREFIX = { message: "m", person: "p", channel: "c" } as const;
export type IdKind = keyof typeof PREFIX;

const ID = /^([mpc])([1-9]\d{0,14})$/;

export const makeId = (kind: IdKind, seq: number) => `${PREFIX[kind]}${seq}`;

/** The kind and number of a Household id; undefined for anything else (a channel's raw id, a name, …). */
export function parseId(value: string): { kind: IdKind; seq: number } | undefined {
  const match = ID.exec(value);
  if (!match) return undefined;
  const kind = (Object.keys(PREFIX) as IdKind[]).find((candidate) => PREFIX[candidate] === match[1])!;
  return { kind, seq: Number(match[2]) };
}

/** The number of `value` if it is a Household id of `kind`; throws, naming the expected form, if it is not. */
export function expectId(kind: IdKind, value: string): number {
  const id = parseId(value);
  const shown = value.length > 40 ? `${value.slice(0, 39)}…` : value;
  if (!id) throw new HouseholdError(`${shown} is not a Household id: use an id from a header (event.id, from.id, channel.id)`);
  if (id.kind !== kind) throw new HouseholdError(`${shown} is a ${id.kind} id, not a ${kind} id (${PREFIX[kind]}<n>)`);
  return id.seq;
}
