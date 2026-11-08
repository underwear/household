import type { Database } from "bun:sqlite";
import { MemoryError, memoryKey, memoryWrite, memoryDelete, memoryQuery, parseMemory, type MemoryEntry, type MemoryPage, type MemorySummary } from "../core/memory";

/** Current entries retain tombstones; revisions never repeat, including after delete/recreate. */
export class MemoryStore {
  constructor(private readonly db: Database) {}
  get(house: string, pet: string, key: string): MemoryEntry {
    parseMemory(memoryKey, key);
    return this.db.query<MemoryEntry, [string,string,string]>("SELECT key,value,revision,updated,actor FROM pet_memory WHERE house=? AND pet=? AND key=?").get(house,pet,key)
      ?? { key, value: null, revision: 0, updated: "", actor: "" };
  }
  list(house: string, pet: string, input: unknown = {}): MemoryPage {
    const q = parseMemory(memoryQuery, input);
    const terms = q.query?.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (q.query && !terms.length) return { entries: [] };
    const match = terms.map(t => `"${t}"*`).join(" AND ");
    const rows = this.db.query<MemorySummary, any[]>(`SELECT key,revision,updated,actor,value IS NULL AS deleted,substr(coalesce(value,''),1,180) AS excerpt FROM pet_memory
      WHERE house=? AND pet=? AND (? OR value IS NOT NULL) AND (?='' OR key=? OR substr(key,1,length(?)+1)=? || '.') AND key>?
      ${match ? "AND id IN (SELECT rowid FROM pet_memory_search WHERE pet_memory_search MATCH ?)" : ""}
      ORDER BY key LIMIT ?`).all(house,pet,q.deleted ? 1:0,q.prefix??"",q.prefix??"",q.prefix??"",q.prefix??"",q.after??"",...(match?[match]:[]),q.limit+1);
    const more = rows.length > q.limit;
    const entries = rows.slice(0,q.limit).map(row => ({...row,deleted:!!row.deleted}));
    return { entries, ...(more ? {next:entries.at(-1)!.key}: {}) };
  }
  write(house: string, pet: string, input: unknown, actor: "pet" | "owner"): MemoryEntry {
    const fields = parseMemory(memoryWrite,input);
    if (fields.key === "core" && fields.value.length > 8000) throw new MemoryError("core is limited to 8000 characters; move details to topic entries");
    return this.change(house,pet,fields.key,fields.revision,fields.value,actor);
  }
  delete(house: string, pet: string, input: unknown, actor: "pet" | "owner"): MemoryEntry {
    const fields = parseMemory(memoryDelete,input);
    return this.change(house,pet,fields.key,fields.revision,null,actor);
  }
  private change(house: string, pet: string, key: string, expected: number, value: string | null, actor: string): MemoryEntry {
    return this.db.transaction(() => {
      const old = this.get(house,pet,key);
      if (old.revision !== expected) throw new MemoryError("Memory changed. Read its current revision before editing again.",409);
      if (value === null && old.value === null) throw new MemoryError("Memory entry is already deleted",404);
      const entry = {key,value,revision:old.revision+1,updated:new Date().toISOString(),actor};
      this.db.run(`INSERT INTO pet_memory(house,pet,key,value,revision,updated,actor) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(house,pet,key) DO UPDATE SET value=excluded.value,revision=excluded.revision,updated=excluded.updated,actor=excluded.actor`,
        [house,pet,key,value,entry.revision,entry.updated,actor]);
      this.db.run("INSERT INTO pet_memory_history(house,pet,key,value,revision,updated,actor) VALUES(?,?,?,?,?,?,?)",[house,pet,key,value,entry.revision,entry.updated,actor]);
      return entry;
    }).immediate();
  }
  history(house: string, pet: string, key: string, before = Number.MAX_SAFE_INTEGER): MemoryEntry[] {
    parseMemory(memoryKey,key);
    if (!Number.isSafeInteger(before) || before < 1) throw new MemoryError("before must be a positive revision");
    return this.db.query<MemoryEntry, [string,string,string,number]>("SELECT key,value,revision,updated,actor FROM pet_memory_history WHERE house=? AND pet=? AND key=? AND revision<? ORDER BY revision DESC LIMIT 20").all(house,pet,key,before);
  }
}
