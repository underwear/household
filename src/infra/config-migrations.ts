import { isMap, isScalar, isSeq, visit, type Document, type YAMLMap } from "yaml";
import { CAPABILITY_TEMPLATES, GENERAL_SCOUT, LEGACY_NODE_INSTALLS } from "../builtin-capabilities";
import { HouseholdError } from "../core/errors";
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
  { id: 3, store: "config", name: "the browser and dev capabilities install Node.js 22", change: migrateNodeInstalls },
  { id: 4, store: "config", name: "secrets belong to individual houses", change: migrateHouseSecrets },
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

/**
 * The browser and dev capabilities as their templates made them, with Debian's Node.js 18 (today's Playwright will
 * not run on it), get the templates' install script now. One the owner changed is theirs: left as it is.
 */
function migrateNodeInstalls(doc: Document): void {
  const houses = doc.getIn(["houses"]);
  if (!isMap(houses)) return;
  for (const pair of houses.items) {
    if (!isScalar(pair.key)) continue;
    const capabilities = doc.getIn(["houses", pair.key.value, "capabilities"]);
    if (!isSeq(capabilities)) continue;
    for (const item of capabilities.items) {
      if (!isMap(item)) continue;
      const name = item.get("name");
      const legacy = typeof name === "string" ? LEGACY_NODE_INSTALLS[name] : undefined;
      const template = CAPABILITY_TEMPLATES.find(each => each.name === name);
      if (legacy && template && item.get("install") === legacy) item.set("install", template.install);
    }
  }
}

/** Copy legacy shared credentials to their existing recipients, then remove the global catalog.
 * Never discard an orphan or overwrite a local credential: the operator can resolve it from the backup.
 */
export function migrateHouseSecrets(doc: Document): void {
  if (!doc.hasIn(["secrets"])) return;
  // Materialize aliases before removing their anchors or copying credentials between houses.
  visit(doc, { Alias: (_key, node) => doc.createNode(node.toJS(doc)) });
  const secrets = doc.getIn(["secrets"]);
  if (secrets == null) { doc.deleteIn(["secrets"]); return; }
  if (!isMap(secrets)) throw new HouseholdError("Legacy secrets must be a mapping");
  const houses = doc.getIn(["houses"]);
  const names = isMap(houses) ? houses.items.map(pair => String(isScalar(pair.key) ? pair.key.value : "")) : [];
  const copies: { house: string; name: string; value: YAMLMap }[] = [];
  for (const pair of secrets.items) {
    if (!isScalar(pair.key) || !isMap(pair.value)) throw new HouseholdError("Invalid legacy secret entry");
    const name = String(pair.key.value);
    const recipients = pair.value.get("houses");
    if (recipients !== undefined && (!isSeq(recipients) || !recipients.items.length || recipients.items.some(item => !isScalar(item) || typeof item.value !== "string")))
      throw new HouseholdError(`Secret '${name}' has invalid workspaces`);
    const targets = isSeq(recipients) ? recipients.items.map(item => String((item as { value: unknown }).value)) : names;
    if (!targets.length || targets.some(house => !names.includes(house)))
      throw new HouseholdError(`Secret '${name}' has no existing destination house; assign it before migrating`);
    for (const house of new Set(targets)) {
      if (doc.hasIn(["houses", house, "secrets", name])) throw new HouseholdError(`Secret '${house}/${name}' already exists; resolve the legacy conflict before migrating`);
      const value = pair.value.clone() as YAMLMap;
      value.delete("houses");
      visit(value, { Node: (_key, node) => { if ("anchor" in node) delete node.anchor; } });
      copies.push({ house, name, value });
    }
  }
  for (const { house, name, value } of copies) setIn(doc, ["houses", house, "secrets", name], value);
  doc.deleteIn(["secrets"]);
}
