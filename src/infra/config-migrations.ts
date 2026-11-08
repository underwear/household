import { isMap, isScalar, isSeq, type Document } from "yaml";
import { GENERAL_SCOUT } from "../builtin-capabilities";
import { setIn } from "./yaml-doc";

/**
 * A change to household.yaml that this Household reads differently from what earlier ones wrote. Each runs once,
 * in order of its id (shared with the state migrations in app/migrations.ts: one sequence, append only, never
 * renumbered); the config's `version` is the id of the last one it has had. A step changes only the YAML document
 * and must be harmless on a config that has nothing of what it rewrites (a fresh one, or one that never had it).
 */
export interface ConfigMigration {
  id: number;
  /** What it does, in a few words: shown by `house migrate` and logged when it runs. */
  name: string;
  store: "config";
  change(doc: Document): void;
}

export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [
  { id: 1, store: "config", name: "a house's default scout becomes the General scout", change: migrateDefaultScouts },
  { id: 2, store: "config", name: "scouts' maximum run time is dropped", change: (doc) => { for (const path of legacyTimeouts(doc)) doc.deleteIn(path); } },
];

/** The config version this Household writes: a config with a newer one is from a newer Household, and not read. */
export const CONFIG_VERSION = Math.max(0, ...CONFIG_MIGRATIONS.map((migration) => migration.id));

/** Houses whose config still has a default scout: the capabilities pets once assembled a scout from. */
function legacyDefaultScouts(doc: Document): string[] {
  const houses = doc.getIn(["houses"]);
  return isMap(houses) ? houses.items.flatMap(pair => isScalar(pair.key) && doc.hasIn(["houses", pair.key.value, "defaultScout"]) ? [String(pair.key.value)] : []) : [];
}

/** Where the config still gives scouts a maximum run time: the house's limits, and each scout's own resources. */
function legacyTimeouts(doc: Document): unknown[][] {
  const houses = doc.getIn(["houses"]);
  if (!isMap(houses)) return [];
  return houses.items.flatMap(pair => {
    if (!isScalar(pair.key)) return [];
    const house = pair.key.value;
    const scouts = doc.getIn(["houses", house, "scouts"]);
    const own = isSeq(scouts) ? scouts.items.map((_, index) => ["houses", house, "scouts", index, "resources", "timeoutMinutes"]) : [];
    return [["houses", house, "scoutLimits", "timeoutMinutes"], ...own].filter(path => doc.hasIn(path));
  });
}

/**
 * A default scout becomes the General scout: a named scout of the capabilities it had switched on (unless the house
 * already has one called general), so its pets keep calling the same thing, by name.
 */
function migrateDefaultScouts(doc: Document): void {
  for (const house of legacyDefaultScouts(doc)) {
    const on = doc.getIn(["houses", house, "defaultScout", "capabilities"]);
    const names = on && isSeq(on) ? on.items.flatMap(item => isScalar(item) && typeof item.value === "string" ? [item.value] : []) : [];
    const scouts = doc.getIn(["houses", house, "scouts"]);
    const taken = isSeq(scouts) && scouts.items.some(item => isMap(item) && item.get("name") === GENERAL_SCOUT.name);
    if (!taken) {
      const general = { ...GENERAL_SCOUT, capabilities: names };
      if (isSeq(scouts)) scouts.items.push(doc.createNode(general)); else setIn(doc, ["houses", house, "scouts"], doc.createNode([general]));
    }
    doc.deleteIn(["houses", house, "defaultScout"]);
  }
}
