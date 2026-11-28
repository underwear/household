import { defaultPet, petNames, type ChannelConfig } from "./channels";
import type { Pet } from "./household";

/**
 * Who a person's message in a channel goes to: always exactly one pet, by Household's
 * rule, the same in every channel; the adapter only gives the facts (where it was written, what it quotes).
 */

/** Household's facts about a message, each naming a pet (by name) if it holds. */
export interface RouteFacts {
  /** What the message is about is in this pet's conversation: what a reaction is on, what an edit changes. */
  about?: string;
  /** It was written in this pet's own place (its thread). */
  thread?: string;
  /** It quotes (replies to) a line of this pet. */
  quoted?: string;
  /** The person's own words, whose start may name a pet. */
  text?: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The pet a text calls by name: one of its names (name, title, alias; case does not count) at the very start,
 * followed by `,`, `:` or a line break ("Chef, plan the menu"). A name later on ("ask the Chef") is not an
 * address. Undefined when the text calls none of `pets`.
 */
export function addressee(text: string, pets: Pet[]): Pet | undefined {
  return pets.find((pet) => petNames(pet).some((name) => new RegExp(`^\\s*${escape(name)}[ \\t]*[,:\\n\\r]`, "iu").test(text)));
}

/**
 * The pet the message goes to: the first of what it is about, the pet whose place it was written in, the pet
 * whose line it quotes, the pet its start calls by name, and the channel's default. Only pets placed in the
 * channel count (`pets`: the house's). Undefined only for a channel without pets.
 */
export function routedPet(channel: ChannelConfig, pets: Pet[], facts: RouteFacts): Pet | undefined {
  const placed = pets.filter((pet) => channel.pets.includes(pet.name));
  const named = (name: string | undefined) => (name === undefined ? undefined : placed.find((pet) => pet.name === name));
  return (
    named(facts.about) ??
    named(facts.thread) ??
    named(facts.quoted) ??
    (facts.text === undefined ? undefined : addressee(facts.text, placed)) ??
    named(defaultPet(channel))
  );
}
