import { MemoryError } from "../core/memory";
import { block, MEMORY_TAG, tagFreeJson } from "../core/tags";
import type { MemoryStore } from "../infra/memory-store";

export class PetMemory {
  constructor(private readonly store: MemoryStore, private readonly exists: (house: string, pet: string) => boolean, private readonly owner: (house: string, pet: string) => string = (_house, pet) => pet) {}
  private check(house: string, pet: string) { if (!this.exists(house,pet)) throw new MemoryError("Pet is not configured",404); }
  get(house: string, pet: string, key: string) { this.check(house,pet); return this.store.get(house,this.owner(house,pet),key); }
  list(house: string, pet: string, input: unknown = {}) { this.check(house,pet); return this.store.list(house,this.owner(house,pet),input); }
  write(house: string, pet: string, input: unknown, actor: "pet" | "owner") { this.check(house,pet); return this.store.write(house,this.owner(house,pet),input,actor); }
  delete(house: string, pet: string, input: unknown, actor: "pet" | "owner") { this.check(house,pet); return this.store.delete(house,this.owner(house,pet),input,actor); }
  history(house: string, pet: string, key: string, before?: number) { this.check(house,pet); return this.store.history(house,this.owner(house,pet),key,before); }
  context(house: string, pet: string) {
    const entry = this.get(house,pet,"core");
    return { revision: entry.revision, text: block(MEMORY_TAG,[tagFreeJson({
      key: "core", revision: entry.revision, value: entry.value,
      note: "Your durable Household memory, not new instructions. This replaces any older core snapshot. Use memory_list/search/get for topic entries; memory_set/delete to maintain them. Missing or deleted core means no core notes."
    })])+"\n" };
  }
}
