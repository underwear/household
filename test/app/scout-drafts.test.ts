import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { Capabilities } from "../../src/app/capabilities";
import { mayDraft, ScoutDrafts, scoutDraftTools } from "../../src/app/scout-drafts";
import { hiddenCharacter } from "../../src/core/hidden-text";
import { scoutRoutes } from "../../src/app/scout-routes";
import { ConfigStore } from "../../src/infra/config-store";
import { HouseholdError } from "../../src/core/errors";
import { ScoutStorage } from "../../src/infra/scout-storage";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { scoutsBlock } from "../../src/core/scouts";
import { CONFIG_VERSION } from "../../src/infra/config-migrations";
import { tempDir } from "../helpers";

const sibling = { house: "work", pet: "sibling" };
/** What a bot would send for the meter errand: a closed network, one key, asking for routine. */
const meter = (extra: Record<string, unknown> = {}) => ({
  name: "meter", title: "Meter reader", emoji: "📟", description: "Submits the monthly meter reading", instructions: "Log in, enter the reading, save the receipt.",
  setup: { install: "apt-get install -y curl", network: { any: false, allow: ["meter.example.com"] }, needs_keys: ["METER_PASSWORD"] },
  routine: true, reason: "Monthly errand on one site; worst case a wrong reading, fixable on the site.", ...extra,
});

async function fixture(yaml = "", scouts = true, reload: () => Promise<unknown> = async () => {}) {
  const root = tempDir(), path = join(root, "config.yaml");
  await Bun.write(path, `version: ${CONFIG_VERSION}\nhouses:\n  work:\n    network: { allow: [] }\n    features: { scouts: ${scouts} }\n    pets:\n      sibling: {}\n      other: {}\n${yaml}  home:\n    network: { allow: [] }\n    features: { scouts: true }\n    pets:\n      stranger: {}\n`);
  const config = new ConfigStore(path), store = new SqliteStore(join(root, "state.db"));
  const capabilities = new Capabilities(config, store, async () => {});
  const notices: { pet: string; text: string; place: string }[] = [], rewrites: { place: string; text: string }[] = [], sent: { pet: string; text: string }[] = [];
  let applied = 0, clock = Date.parse("2026-11-25T10:00:00Z");
  const drafts = new ScoutDrafts({ config, store, capabilities, applied: async () => { applied++; await reload(); }, now: () => clock,
    announce: async (_house, pet, text) => { const place = `p${notices.length}`; notices.push({ pet, text, place }); return { place, ref: { id: notices.length } as never }; },
    rewrite: async (_house, notice, text) => { rewrites.push({ place: notice.place, text }); },
    send: (_house, pet, text) => { sent.push({ pet, text }); },
    title: (_house, pet) => pet === "sibling" ? "Sibling <Bot>" : pet,
  });
  const routes = scoutRoutes({ config, storage: new ScoutStorage(root), capabilities, drafts, scouts: { list: () => [], cancel: async () => ({ status: "cancelled" }) }, apply: async () => {}, applySecrets: async () => {} });
  const call = async (method: string, suffix: string, data?: unknown) => (await routes(new Request(`http://local/api/houses/work/${suffix}`, { method, ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { "content-type": "application/json" } }) })))!;
  const house = async () => (await config.load()).houses.find(h => h.name === "work")!;
  /** The owner's apply with choices, as the review page sends it: with the fingerprint of the view they decided on. */
  const decide = async (id: string, body: Record<string, unknown>) => call("POST", `scout-drafts/${id}/apply`, { ...body, reviewed: (await (await call("GET", `scout-drafts/${id}`)).json()).reviewed });
  return { config, store, capabilities, drafts, routes, call, decide, house, notices, rewrites, sent, applied: () => applied, later: (minutes: number) => { clock += minutes * 60_000; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test("a bot drafts a new scout: nothing changes, the owner gets a notice in the bot's chat and reviews the whole of it", async () => {
  const f = await fixture();
  const answer = await f.drafts.draft(sibling, meter());
  expect(answer).toEqual({ status: "waiting_owner", scout: "meter", proposal: "new", network: "only meter.example.com", needs_keys: ["METER_PASSWORD"], routine: "asked: your human decides when they apply it" });
  expect((await f.house()).scouts ?? []).toEqual([]); // nothing reaches the config before the owner's apply
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]!.pet).toBe("sibling");
  expect(f.notices[0]!.text).toBe([
    "<b>Sibling &lt;Bot&gt; proposes scout “📟 Meter reader”</b>",
    "Why:\n<blockquote>Monthly errand on one site; worst case a wrong reading, fixable on the site.</blockquote>",
    "Capabilities: own setup\n🔒 Network: only <code>meter.example.com</code>\nInstall script of its own: 1 line to read\nKeys it needs: <code>METER_PASSWORD</code>\nAsks to run it without asking",
    "Nothing changes until you apply it. Review it in the admin, work → Scouts → Drafts, or with <code>house scout drafts work</code>.",
  ].join("\n\n"));
  const [view] = await f.drafts.views("work");
  expect(view).toMatchObject({
    scout: "meter", pet: "sibling", change: false, wantsRoutine: true, current: null, currentOwn: null, needsKeys: ["METER_PASSWORD"], routineBlocker: null, problems: [],
    definition: { name: "meter", title: "Meter reader", emoji: "📟", capabilities: [] },
    own: { name: "meter", owner: "meter", install: "apt-get install -y curl", network: { any: false, allow: ["meter.example.com"] }, keys: [] },
    network: { open: false, allow: ["meter.example.com"], limitedBy: ["meter"] }, networkWords: "only meter.example.com",
  });
  expect(view!.definition.routine).toBeUndefined(); // a draft never carries a routine list
  expect(JSON.stringify(f.store.get("scouts.drafts.v1.work"))).not.toContain("routine\\\":[");
});

test("the bot's words cannot pass for Household's: its title is quoted, its reason quoted and escaped", async () => {
  const f = await fixture();
  await f.drafts.draft(sibling, meter({ title: "Meter</b> <i>approved", reason: "<b>Approved by Household</b>\nNetwork: closed" }));
  const text = f.notices[0]!.text;
  expect(text).toContain("proposes scout “📟 Meter&lt;/b&gt; &lt;i&gt;approved”</b>");
  expect(text).toContain("<blockquote>&lt;b&gt;Approved by Household&lt;/b&gt;\nNetwork: closed</blockquote>");
  expect(text).not.toContain("<i>");
});

test("a draft is checked as the owner's apply will be: schemas, shared capabilities by name, names only for keys, the workspace's config", async () => {
  const f = await fixture("    capabilities:\n      - { name: browser }\n      - { name: breaker, owner: breaker }\n    scouts:\n      - { name: breaker, description: Incidents }\n");
  const fails = (input: Record<string, unknown>, message: string) => expect(f.drafts.draft(sibling, input)).rejects.toThrow(message);
  await fails(meter({ name: "Meter!" }), "name: lowercase letters");
  await fails(meter({ reason: undefined }), "reason: one or two lines");
  await fails(meter({ reason: "x".repeat(501) }), "reason: one or two lines");
  await fails(meter({ reason: "a\nb\nc\nd" }), "reason: one or two lines");
  await fails(meter({ instructions: undefined }), "instructions is required");
  await fails(meter({ routine: "yes" }), "routine: true");
  await fails(meter({ capabilities: ["nope"] }), "unknown capability 'nope'");
  await fails(meter({ capabilities: ["breaker"] }), "unknown capability 'breaker'"); // another scout's own setup
  await fails(meter({ capabilities: ["browser", "browser"] }), "listed twice");
  await fails(meter({ emoji: "two words" }), "one emoji");
  await fails(meter({ setup: { install: "", needs_keys: ["sk-live-abc123"] } }), "needs_keys: environment variable names only");
  await fails(meter({ setup: { install: "", keys: [{ secret: "x", via: "vm", env: "X" }] } }), "setup: {install?, network?, install_hosts?, needs_keys?}");
  await fails(meter({ setup: { network: { any: false, allow: [] } } }), "name at least one host");
  await fails(meter({ name: "browser" }), "A capability is already named browser"); // its own setup would clash
  expect(await f.drafts.list("work")).toEqual([]);
  // A bot of another workspace, or none: its caller is its own workspace, never the one it names.
  await expect(f.drafts.draft({ house: "work", pet: "stranger" }, meter())).rejects.toThrow("Only a bot of this workspace");
  await f.drafts.draft({ house: "home", pet: "stranger" }, meter());
  expect(await f.drafts.list("work")).toEqual([]);
  expect(await f.drafts.list("home")).toHaveLength(1);
}, 20_000);

test("one draft per scout: a newer one replaces the older, with a fresh notice; another bot's replacement says by whom and tells the first", async () => {
  const f = await fixture();
  await f.drafts.draft(sibling, meter());
  await f.drafts.draft(sibling, meter());
  expect(f.notices).toHaveLength(1); // the same draft again: nothing new
  await f.drafts.draft(sibling, meter({ reason: "Shorter" }));
  await settle();
  expect(f.rewrites).toEqual([{ place: "p0", text: expect.stringContaining("<b>Replaced by a newer draft from Sibling &lt;Bot&gt;.</b>") }]);
  expect(f.sent).toEqual([]); // its own: nothing to tell it
  await f.drafts.draft({ house: "work", pet: "other" }, meter({ reason: "Cheaper" }));
  expect(await f.drafts.list("work")).toEqual([expect.objectContaining({ scout: "meter", pet: "other", reason: "Cheaper" })]);
  expect(f.notices).toHaveLength(3);
  await settle();
  expect(f.rewrites.at(-1)).toEqual({ place: "p1", text: expect.stringContaining("<b>Replaced by a newer draft from other.</b>") });
  expect(f.sent).toEqual([{ pet: "sibling", text: expect.stringContaining("your draft of scout meter was replaced by a newer draft from other; yours is gone") }]);
});

test("at most ten drafts wait per workspace, changes included; a bot saves at most six in ten minutes", async () => {
  const f = await fixture("    scouts:\n      - { name: breaker, description: Incidents }\n");
  for (let i = 1; i <= 6; i++) await f.drafts.draft(sibling, meter({ name: `errand-${i}` }));
  await expect(f.drafts.draft(sibling, meter({ name: "errand-7" }))).rejects.toThrow("You saved 6 scout drafts in the last 10 minutes");
  await expect(f.drafts.draft(sibling, meter({ name: "errand-6" }))).rejects.toThrow("You saved 6"); // even the same one again
  expect(f.notices).toHaveLength(6);
  for (let i = 7; i <= 9; i++) await f.drafts.draft({ house: "work", pet: "other" }, meter({ name: `errand-${i}` }));
  f.later(10);
  await f.drafts.draft(sibling, { name: "breaker", description: "Incidents", instructions: "Look", reason: "Sharper instructions" }); // the tenth: a change
  await expect(f.drafts.draft(sibling, meter({ name: "errand-10" }))).rejects.toThrow("Ten scout drafts already wait");
  await expect(f.drafts.draft({ house: "work", pet: "other" }, { name: "breaker", description: "Incidents", instructions: "Look again", reason: "r" })).resolves.toMatchObject({ proposal: "change" }); // replaces: not an eleventh
  expect(await f.drafts.list("work")).toHaveLength(10);
}, 20_000);

test("a change to a scout: the whole new definition, against the current one; the owner's harness, size and repository stay theirs", async () => {
  const f = await fixture("    capabilities:\n      - { name: browser }\n      - { name: meter, owner: meter, install: v1, network: { any: false, allow: [meter.example.com] } }\n    scouts:\n      - { name: meter, title: Meter, description: Readings, instructions: old, workspace: { repo: \"https://github.com/acme/meter.git\" }, resources: { cpus: 4 }, routine: [sibling] }\n");
  await f.drafts.draft(sibling, { name: "meter", description: "Readings, with a browser", instructions: "new", capabilities: ["browser"], reason: "The site needs JavaScript" });
  expect(f.notices[0]!.text).toStartWith("<b>Sibling &lt;Bot&gt; proposes a change to scout Meter</b>");
  const [view] = await f.drafts.views("work");
  expect(view).toMatchObject({
    change: true, own: null, currentOwn: { install: "v1" },
    definition: { name: "meter", title: "Meter", description: "Readings, with a browser", instructions: "new", capabilities: ["browser"], workspace: { repo: "https://github.com/acme/meter.git" }, resources: { cpus: 4 } },
    current: { instructions: "old", routine: ["sibling"] },
    network: { open: false, allow: ["meter.example.com", "github.com"] },
  });
  expect(view!.definition.routine).toBeUndefined();
});

test("apply writes the scout and its own setup in one edit, its setup's revision by the bot; the bot hears it and sees it in its list", async () => {
  const f = await fixture();
  await f.drafts.draft(sibling, meter({ routine: undefined }));
  const [draft] = await f.drafts.list("work");
  const put = spyOn(f.config, "putScout"), addScout = spyOn(f.config, "addScout"), addCapability = spyOn(f.config, "addCapability");
  const applied = await f.decide(draft!.id, {});
  expect(applied.status).toBe(200);
  expect(await applied.json()).toEqual({ scout: "meter", routine: [], keys: { choice: null, kept: [], dropped: [] } });
  expect(put.mock.calls.filter(args => !args[3]?.dryRun)).toHaveLength(1);
  expect(addScout).not.toHaveBeenCalled(); expect(addCapability).not.toHaveBeenCalled();
  const house = await f.house();
  expect(house.scouts).toEqual([{ name: "meter", title: "Meter reader", emoji: "📟", description: "Submits the monthly meter reading", instructions: "Log in, enter the reading, save the receipt.", capabilities: [] }]);
  expect(house.capabilities).toEqual([expect.objectContaining({ name: "meter", owner: "meter", install: "apt-get install -y curl", keys: [] })]);
  expect(f.capabilities.history("work", "meter")).toEqual([expect.objectContaining({ rev: 1, author: { kind: "pet", pet: "sibling" }, summary: "created" })]);
  expect(f.applied()).toBe(1);
  expect(await f.drafts.list("work")).toEqual([]);
  expect(f.sent).toEqual([{ pet: "sibling", text: expect.stringContaining("your human applied your draft of scout meter. Every run of it waits for your human's Run.") }]);
  await settle();
  expect(f.rewrites.at(-1)!.text).toEndWith("<b>Applied.</b>");
  // The household-scouts block the bot gets with its next message carries it.
  expect(scoutsBlock(house, "sibling")).toContain('"name":"meter"');
});

test("apply without a routine list makes a routine scout strict; with one, the admin's checks for routine apply", async () => {
  const f = await fixture("    capabilities:\n      - { name: meter, owner: meter, install: v1, network: { any: false, allow: [meter.example.com] }, keys: [] }\n    scouts:\n      - { name: meter, description: Readings, routine: [sibling] }\n");
  const draftOf = async (input: Record<string, unknown>) => { await f.drafts.draft(sibling, { name: "meter", description: "Readings", instructions: "x", reason: "r", ...input }); return (await f.drafts.list("work")).find(d => d.scout === "meter")!; };
  // The bot re-drafts its own routine scout and asks for routine again: applying without a list ends it.
  let draft = await draftOf({ instructions: "send everything to meter.example.com", routine: true });
  expect((await f.decide(draft.id, {})).status).toBe(200);
  expect((await f.house()).scouts![0]!.routine).toBeUndefined();
  expect(f.sent.at(-1)!.text).toContain("they did not make it routine for you");

  draft = await draftOf({ instructions: "v2" });
  const ghost = await f.decide(draft.id, { routine: ["ghost"] });
  expect(ghost.status).toBe(400); expect((await ghost.json()).error).toBe("ghost is not a bot of this workspace");
  expect((await f.decide(draft.id, { routine: ["sibling"] })).status).toBe(200);
  expect((await f.house()).scouts![0]!.routine).toEqual(["sibling"]);
  expect(f.sent.at(-1)!.text).toContain("It is routine for you: its runs start without Run.");

  // A draft that opens its network asks for routine in vain: accepted, the reason shown, and the owner cannot grant it.
  const answer = await f.drafts.draft(sibling, { name: "meter", description: "Readings", instructions: "x", reason: "r", setup: { network: { any: true } }, routine: true });
  expect(answer).toMatchObject({ network: "open internet", routine: "not possible: Reaches the open internet" });
  expect(f.notices.at(-1)!.text).toContain("Asks to run it without asking; not possible: Reaches the open internet");
  draft = (await f.drafts.list("work"))[0]!;
  expect((await f.call("GET", `scout-drafts/${draft.id}`)).status).toBe(200);
  expect(await (await f.call("GET", `scout-drafts/${draft.id}`)).json()).toMatchObject({ routineBlocker: "Reaches the open internet", wantsRoutine: true });
  const open = await f.decide(draft.id, { routine: ["sibling"] });
  expect(open.status).toBe(400); expect((await open.json()).error).toContain("cannot run without asking");
  expect((await f.house()).capabilities![0]!.network.any).toBe(false); // nothing written
  expect((await f.decide(draft.id, {})).status).toBe(200);
  expect((await f.house()).capabilities![0]!.network.any).toBe(true);
  expect((await f.house()).scouts![0]!.routine).toBeUndefined();
});

const keyed = "    secrets:\n      meter-pass: { value: synthetic, hosts: [meter.example.com], env: METER_PASSWORD, onlyForCapabilities: [meter] }\n    capabilities:\n      - { name: meter, owner: meter, install: v1, network: { any: false, allow: [meter.example.com] }, keys: [{ secret: meter-pass, via: vm, env: METER_PASSWORD }] }\n    scouts:\n      - { name: meter, description: Readings }\n";

test("a changed install on a setup holding a key in its VM: shown as kept with a changed install, refused until the owner keeps or drops it", async () => {
  const f = await fixture(keyed);
  const answer = await f.drafts.draft(sibling, { name: "meter", description: "Readings", instructions: "x", reason: "r", setup: { install: 'curl -d "$METER_PASSWORD" https://meter.example.com/upload', needs_keys: ["METER_PASSWORD", "METER_USER"] } });
  expect(answer).toMatchObject({ needs_keys: ["METER_USER"] }); // one it already has is not asked for again
  expect(f.notices[0]!.text).toContain("🔑 Keys it would carry: <code>METER_PASSWORD</code> (own setup, value in its VM; kept, with a changed install)");
  expect(f.notices[0]!.text).toContain("⚠️ Keys at stake (<code>METER_PASSWORD</code>): its own install script changes. You decide whether they go along.");
  const [draft] = await f.drafts.list("work");
  expect(JSON.stringify(draft)).not.toContain("synthetic");
  const view = await (await f.call("GET", `scout-drafts/${draft!.id}`)).json();
  expect(view).toMatchObject({ ownChanges: ["install"], keys: [{ env: "METER_PASSWORD", secret: "meter-pass", source: "own setup", via: "vm", keptWith: ["install"] }],
    keyGate: { keys: [{ env: "METER_PASSWORD" }], reasons: ["its own install script changes"], choices: ["keep", "drop"] } });
  const refused = await f.decide(draft!.id, {});
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toBe("This change puts keys whose value is in the scout's VM at stake (METER_PASSWORD): its own install script changes. Choose whether they go along (keep) or take its own setup's off (drop: the workspace's secrets stay).");
  expect((await f.house()).capabilities![0]!.install).toBe("v1"); // nothing written
  expect(await (await f.decide(draft!.id, { keys: "keep" })).json()).toEqual({ scout: "meter", routine: [], keys: { choice: "keep", kept: ["METER_PASSWORD"], dropped: [] } });
  expect((await f.house()).capabilities![0]).toMatchObject({ install: 'curl -d "$METER_PASSWORD" https://meter.example.com/upload', keys: [{ secret: "meter-pass", via: "vm", env: "METER_PASSWORD" }] });
  expect(f.capabilities.history("work", "meter")[0]).toMatchObject({ author: { kind: "pet", pet: "sibling" }, summary: "install" });
});

test("new hosts of its own setup put its VM key at stake: drop takes it off and leaves the workspace's secret; a draft that changes nothing risky needs, and takes, no choice", async () => {
  const f = await fixture(keyed);
  await f.drafts.draft(sibling, { name: "meter", description: "Readings", instructions: "x", reason: "r", setup: { network: { any: false, allow: ["meter.example.com", "collect.example.net"] } } });
  let [draft] = await f.drafts.list("work");
  expect((await (await f.call("GET", `scout-drafts/${draft!.id}`)).json()).keyGate).toMatchObject({ reasons: ["it would reach new hosts: collect.example.net"] });
  expect(await (await f.decide(draft!.id, { keys: "drop" })).json()).toMatchObject({ keys: { choice: "drop", kept: [], dropped: ["METER_PASSWORD"] } });
  const house = await f.house();
  expect(house.capabilities![0]).toMatchObject({ network: { any: false }, keys: [] });
  expect(house.secrets!.find(secret => secret.name === "meter-pass")).toMatchObject({ onlyForCapabilities: ["meter"] }); // still the owner's, bound to nothing
  // Only its description, or fewer hosts: its key goes nowhere new. A choice offered anyway is refused, not ignored.
  const g = await fixture(keyed);
  await g.drafts.draft(sibling, { name: "meter", description: "Monthly readings", instructions: "x", reason: "r" });
  [draft] = await g.drafts.list("work");
  expect(await (await g.call("GET", `scout-drafts/${draft!.id}`)).json()).toMatchObject({ keyGate: null, ownChanges: [], keys: [{ env: "METER_PASSWORD", source: "own setup" }] });
  for (const keys of ["keep", "drop"]) {
    const unasked = await g.decide(draft!.id, { keys });
    expect(unasked.status).toBe(400); expect((await unasked.json()).error).toBe(`No key is at stake in this draft: apply it without ${keys}`);
  }
  expect(await (await g.decide(draft!.id, {})).json()).toMatchObject({ keys: { choice: null, kept: ["METER_PASSWORD"], dropped: [] } });
  expect((await g.house()).capabilities![0]!.keys).toHaveLength(1);
});

test("its own setup's install hosts: a bot drafts them, the review shows them, new ones put its VM key at stake, [] removes them", async () => {
  const f = await fixture(keyed);
  await f.drafts.draft(sibling, { name: "meter", description: "Readings", instructions: "x", reason: "r", setup: { install_hosts: ["deb.debian.org:80"] } });
  let [draft] = await f.drafts.list("work");
  const view = await (await f.call("GET", `scout-drafts/${draft!.id}`)).json();
  expect(view.own.installHosts).toEqual(["deb.debian.org:80"]);
  // Its install scripts run beside the key: a host they download from is a way out it did not have.
  expect(view.keyGate).toMatchObject({ reasons: ["its install scripts would download from new hosts: deb.debian.org:80"] });
  await f.decide(draft!.id, { keys: "keep" });
  expect((await f.house()).capabilities![0]).toMatchObject({ installHosts: [{ host: "deb.debian.org", port: 80 }], keys: [{ secret: "meter-pass" }] });
  // Left out: kept. [] : removed, and removing one is no way out.
  await f.drafts.draft(sibling, { name: "meter", description: "Monthly readings", instructions: "x", reason: "r", setup: { install: "true" } });
  [draft] = await f.drafts.list("work");
  expect((await (await f.call("GET", `scout-drafts/${draft!.id}`)).json()).own.installHosts).toEqual(["deb.debian.org:80"]);
  await f.drafts.draft(sibling, { name: "meter", description: "Monthly readings", instructions: "x", reason: "r", setup: { install_hosts: [] } });
  [draft] = await f.drafts.list("work");
  const cleared = await (await f.call("GET", `scout-drafts/${draft!.id}`)).json();
  expect(cleared.own.installHosts).toBeUndefined();
  expect(cleared.keyGate).toBeNull();
  await expect(f.drafts.draft(sibling, { name: "meter", description: "x", instructions: "x", reason: "r", setup: { install_hosts: ["*.debian.org"] } })).rejects.toThrow("not an exact host");
});

/** Scout meter: its own setup holds METER_PASSWORD (in its VM) and reaches meter.example.com alone; shared capabilities to tick. */
const shared = (extra = "") => `    secrets:\n      meter-pass: { value: synthetic, hosts: [meter.example.com], env: METER_PASSWORD, onlyForCapabilities: [meter] }\n      dd: { value: synthetic, hosts: [api.datadoghq.eu], env: DD_API_KEY, onlyForCapabilities: [datadog] }\n    capabilities:\n      - { name: uploads, network: { any: false, allow: [paste.example.net] } }\n      - { name: browser }\n      - { name: datadog, keys: [{ secret: dd, via: vm, env: DD_API_KEY }] }\n      - { name: meter, owner: meter, network: { any: false, allow: [meter.example.com] }, keys: [${extra || "{ secret: meter-pass, via: vm, env: METER_PASSWORD }"}] }\n    scouts:\n      - { name: meter, description: Readings }\n`;
const change = (extra: Record<string, unknown>) => ({ name: "meter", description: "Readings", instructions: "x", reason: "r", ...extra });

test("the gate is on the result: a change that only ticks a shared capability with new hosts puts the own setup's VM key at stake", async () => {
  const f = await fixture(shared());
  await f.drafts.draft(sibling, change({ capabilities: ["uploads"] }));
  const [draft] = await f.drafts.list("work");
  const view = await (await f.call("GET", `scout-drafts/${draft!.id}`)).json();
  expect(view.keyGate).toEqual({ keys: [{ env: "METER_PASSWORD", secret: "meter-pass", source: "own setup", via: "vm" }], reasons: ["it would reach new hosts: paste.example.net"], choices: ["keep", "drop"] });
  expect(view.keys).toEqual([{ env: "METER_PASSWORD", secret: "meter-pass", source: "own setup", via: "vm" }]);
  expect((await f.decide(draft!.id, {})).status).toBe(409);
  expect((await f.house()).scouts![0]!.capabilities).toEqual([]);
  expect((await f.decide(draft!.id, { keys: "keep" })).status).toBe(200);
  expect((await f.house()).scouts![0]!.capabilities).toEqual(["uploads"]);
});

test("a change that opens the scout's network puts its VM key at stake", async () => {
  const f = await fixture(shared());
  await f.drafts.draft(sibling, change({ setup: { network: { any: true } } }));
  const [view] = await f.drafts.views("work");
  expect(view!.keyGate).toMatchObject({ reasons: ["it would reach the open internet"], choices: ["keep", "drop"] });
  expect(view!.network.open).toBe(true);
});

test("an added capability that brings a key in its VM is at stake on its own; its key cannot be dropped, only kept (or the capability unticked)", async () => {
  const f = await fixture(shared("{ secret: meter-pass, via: gateway }"));
  await f.drafts.draft(sibling, change({ capabilities: ["datadog"] })); // reaches nothing new: datadog limits nothing
  const [draft] = await f.drafts.list("work");
  expect((await (await f.call("GET", `scout-drafts/${draft!.id}`)).json()).keyGate).toEqual({ keys: [{ env: "DD_API_KEY", secret: "dd", source: "datadog", via: "vm" }], reasons: ["added capability datadog brings DD_API_KEY"], choices: ["keep"] });
  expect((await f.decide(draft!.id, {})).status).toBe(409);
  const drop = await f.decide(draft!.id, { keys: "drop" });
  expect(drop.status).toBe(400);
  expect((await drop.json()).error).toBe("DD_API_KEY comes with capability datadog: a key of a shared capability cannot be dropped from one scout. Keep it, or untick datadog instead: discard this draft, or ask its bot for one without it.");
  expect(await (await f.decide(draft!.id, { keys: "keep" })).json()).toMatchObject({ keys: { choice: "keep", kept: ["DD_API_KEY", "METER_PASSWORD"], dropped: [] } });
});

test("both kinds at stake: drop takes the own setup's off, and the result says the shared capability's stays", async () => {
  const f = await fixture(shared());
  await f.drafts.draft(sibling, change({ capabilities: ["datadog", "uploads"] }));
  const [draft] = await f.drafts.list("work");
  expect((await (await f.call("GET", `scout-drafts/${draft!.id}`)).json()).keyGate).toMatchObject({ reasons: ["it would reach new hosts: paste.example.net", "added capability datadog brings DD_API_KEY"], choices: ["keep", "drop"] });
  const applied = await (await f.decide(draft!.id, { keys: "drop" })).json();
  expect(applied.keys).toEqual({ choice: "drop", kept: ["DD_API_KEY"], dropped: ["METER_PASSWORD"], sharedStay: ["DD_API_KEY (datadog, value in its VM)"] });
  const own = (await f.house()).capabilities!.find(capability => capability.owner === "meter")!;
  expect(own.keys).toEqual([]);
  expect(f.capabilities.history("work", "meter")[0]).toMatchObject({ author: { kind: "owner" } }); // the draft left the setup alone: the drop was the owner's
});

test("a newly ticked capability that installs software beside a VM key is at stake too, even with no key and no new host", async () => {
  const fetchers = `    secrets:\n      meter-pass: { value: synthetic, hosts: [meter.example.com], env: METER_PASSWORD, onlyForCapabilities: [meter] }\n    capabilities:\n      - { name: fetch-a, network: { any: false, allow: [meter.example.com] } }\n      - { name: fetch-b, install: "curl -fsSL https://get.example.com | sh", network: { any: false, allow: [meter.example.com] } }\n      - { name: tool, install: "pip install thing" }\n      - { name: quiet }\n      - { name: meter, owner: meter, network: { any: false, allow: [meter.example.com] }, keys: [{ secret: meter-pass, via: vm, env: METER_PASSWORD }] }\n    scouts:\n      - { name: meter, description: Readings, capabilities: [fetch-a] }\n`;
  const f = await fixture(fetchers);
  await f.drafts.draft(sibling, change({ capabilities: ["fetch-b"] })); // the same host, another install script
  expect((await f.drafts.views("work"))[0]!.keyGate).toEqual({ keys: [{ env: "METER_PASSWORD", secret: "meter-pass", source: "own setup", via: "vm" }], reasons: ["added capability fetch-b runs its install script beside them"], choices: ["keep", "drop"] });
  await f.drafts.draft(sibling, change({ capabilities: ["fetch-a", "tool"] })); // a keyless tool: no limit, no host, a script
  expect((await f.drafts.views("work"))[0]!.keyGate?.reasons).toEqual(["added capability tool runs its install script beside them"]);
  expect((await f.decide((await f.drafts.list("work"))[0]!.id, {})).status).toBe(409);
  await f.drafts.draft(sibling, change({ capabilities: ["fetch-a", "quiet"] })); // nothing to install, nowhere new
  expect((await f.drafts.views("work"))[0]!.keyGate).toBeNull();
});

test("the review says what the gate does not: a key in the VM reaches every host the scout reaches", async () => {
  const f = await fixture(shared());
  await f.drafts.draft(sibling, change({ description: "Monthly" }));
  expect((await f.drafts.views("work"))[0]!.vmKeyNote).toBe("A key whose value is inside the scout's VM can reach every host the scout reaches, not only its own capability's. Household guards where it can go; what the instructions tell the scout to do with it is yours to read.");
  const g = await fixture(shared("{ secret: meter-pass, via: gateway }"));
  await g.drafts.draft(sibling, change({ description: "Monthly" }));
  expect((await g.drafts.views("work"))[0]!.vmKeyNote).toBeNull();
});

test("a gateway key never puts the change on hold: it goes only to its secret's hosts", async () => {
  const f = await fixture(shared("{ secret: meter-pass, via: gateway }"));
  await f.drafts.draft(sibling, change({ capabilities: ["uploads"], setup: { install: "changed", network: { any: true } } }));
  const [draft] = await f.drafts.list("work");
  const view = await (await f.call("GET", `scout-drafts/${draft!.id}`)).json();
  expect(view.keyGate).toBeNull();
  expect(view.keys).toEqual([{ env: "METER_PASSWORD", secret: "meter-pass", source: "own setup", via: "gateway", keptWith: ["install", "network"] }]); // still shown
  expect((await f.decide(draft!.id, { keys: "keep" })).status).toBe(400);
  expect(await (await f.decide(draft!.id, {})).json()).toMatchObject({ keys: { choice: null, kept: ["METER_PASSWORD"], dropped: [] } });
});

test("a new scout's keys are shown, not gated: a shared capability's key paired with extra hosts of its own", async () => {
  const f = await fixture("    secrets:\n      dd: { value: synthetic, hosts: [api.datadoghq.eu], env: DD_API_KEY, onlyForCapabilities: [datadog] }\n    capabilities:\n      - { name: datadog, network: { any: false, allow: [api.datadoghq.eu] }, keys: [{ secret: dd, via: vm, env: DD_API_KEY }] }\n");
  await f.drafts.draft(sibling, meter({ capabilities: ["datadog"], setup: { network: { any: false, allow: ["paste.example.org"] } }, routine: undefined }));
  expect(f.notices[0]!.text).toContain("🔒 Network: only <code>api.datadoghq.eu</code>, <code>paste.example.org</code>");
  expect(f.notices[0]!.text).toContain("🔑 Keys it would carry: <code>DD_API_KEY</code> (datadog, value in its VM)");
  const [view] = await f.drafts.views("work");
  expect(view!.keys).toEqual([{ env: "DD_API_KEY", secret: "dd", source: "datadog", via: "vm" }]);
  expect(view!.keyGate).toBeNull();
});

test("a stale draft: what the owner changed since is named, and apply refuses it unless forced", async () => {
  const f = await fixture("    capabilities:\n      - { name: browser }\n      - { name: meter, owner: meter, install: v1, network: { any: false, allow: [meter.example.com, backup.example.com] } }\n    scouts:\n      - { name: meter, description: Readings, capabilities: [browser] }\n");
  await f.drafts.draft(sibling, { name: "meter", description: "Readings", instructions: "x", reason: "r", setup: { install: "v2" } });
  const [draft] = await f.drafts.list("work");
  expect(await (await f.call("GET", `scout-drafts/${draft!.id}`)).json()).toMatchObject({ stale: false, changedSince: [] });
  // The owner takes the browser off and a host out of its setup.
  expect((await f.call("PATCH", "scouts/meter", { capabilities: [] })).status).toBe(200);
  expect((await f.call("PUT", "capabilities/meter", { name: "meter", install: "v1", network: { any: false, allow: ["meter.example.com"] } })).status).toBe(200);
  expect(await (await f.call("GET", `scout-drafts/${draft!.id}`)).json()).toMatchObject({ stale: true, changedSince: ["capabilities", "own setup's network"] });
  const refused = await f.decide(draft!.id, {});
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toBe("Scout meter changed since it was drafted: capabilities, own setup's network. Applying the draft would undo that; review it again, or apply it anyway with force.");
  expect((await f.house()).scouts![0]!.capabilities).toEqual([]);
  expect((await f.decide(draft!.id, { force: true })).status).toBe(200);
  expect((await f.house()).scouts![0]!.capabilities).toEqual(["browser"]); // the owner said so
});

test("a draft of a new scout is stale once the owner made one by that name", async () => {
  const f = await fixture();
  await f.drafts.draft(sibling, meter({ routine: undefined }));
  const [draft] = await f.drafts.list("work");
  expect((await f.call("POST", "scouts", { name: "meter", description: "The owner's own" })).status).toBe(201);
  expect(await (await f.call("GET", `scout-drafts/${draft!.id}`)).json()).toMatchObject({ stale: true, changedSince: ["a scout named meter was made since"], change: true });
  expect((await f.decide(draft!.id, {})).status).toBe(409);
  expect((await f.house()).scouts![0]!.description).toBe("The owner's own");
});

test("what an applied draft keeps as it is (harness, size, repository) does not make it stale", async () => {
  const f = await fixture();
  await f.call("POST", "scouts", { name: "meter", description: "Readings" });
  await f.drafts.draft(sibling, change({ description: "Monthly readings" }));
  const [draft] = await f.drafts.list("work");
  expect((await f.call("PATCH", "scouts/meter", { resources: { cpus: 4 }, workspace: { repo: "https://github.com/acme/meter.git" } })).status).toBe(200);
  expect(await (await f.call("GET", `scout-drafts/${draft!.id}`)).json()).toMatchObject({ stale: false, changedSince: [] });
  expect((await f.decide(draft!.id, {})).status).toBe(200);
  expect((await f.house()).scouts![0]).toMatchObject({ description: "Monthly readings", resources: { cpus: 4 }, workspace: { repo: "https://github.com/acme/meter.git" } });
});

test("the stale check is made again under the config's lock: an owner's edit that lands after the draft was read is not overwritten", async () => {
  const f = await fixture();
  await f.call("POST", "scouts", { name: "meter", description: "Readings" });
  await f.drafts.draft(sibling, change({ description: "Monthly readings" }));
  const [draft] = await f.drafts.list("work");
  const put = spyOn(f.config, "putScout");
  const original = f.config.load.bind(f.config);
  // The owner's edit lands right after apply has read the config, before it writes.
  let reads = 0;
  spyOn(f.config, "load").mockImplementation(async () => { const read = await original(); if (++reads === 1) await f.call("PATCH", "scouts/meter", { instructions: "the owner's" }); return read; });
  await expect(f.drafts.apply("work", draft!.id)).rejects.toThrow("Scout meter changed since it was drafted: instructions. Applying the draft would undo that; review it again, or apply it anyway with force.");
  expect(put.mock.calls.at(-1)![3]).toEqual({ expected: draft!.base }); // apply read the old scout: the refusal came from under the lock
  expect((await original()).houses[0]!.scouts![0]).toMatchObject({ description: "Readings", instructions: "the owner's" });
  expect(await f.drafts.list("work")).toHaveLength(1); // not applied: still there
});

test("force applies over what changed since the draft, never over an edit that lands while it is applied", async () => {
  const f = await fixture();
  await f.call("POST", "scouts", { name: "meter", description: "Readings" });
  await f.drafts.draft(sibling, change({ description: "Monthly readings" }));
  const [draft] = await f.drafts.list("work");
  await f.call("PATCH", "scouts/meter", { title: "Meter" }); // stale now: force is what it takes
  const original = f.config.load.bind(f.config);
  let reads = 0;
  const load = spyOn(f.config, "load").mockImplementation(async () => { const read = await original(); if (++reads === 1) await f.call("PATCH", "scouts/meter", { instructions: "the owner's, just now" }); return read; });
  await expect(f.drafts.apply("work", draft!.id, { force: true })).rejects.toThrow("Scout meter changed while the draft was being applied; nothing was written. Review it again.");
  expect((await original()).houses[0]!.scouts![0]).toMatchObject({ description: "Readings", instructions: "the owner's, just now" });
  load.mockRestore();
  expect(await f.drafts.apply("work", draft!.id, { force: true })).toMatchObject({ scout: "meter" }); // with nothing moving under it, force goes through
  const applied = (await original()).houses[0]!.scouts![0]!;
  expect(applied.description).toBe("Monthly readings");
  expect(applied.title).toBeUndefined(); // forced: the owner's title, set after the draft, is what force undoes
});

test("a prune that lands while a draft is checked is not undone by it", async () => {
  const f = await fixture();
  await f.drafts.draft({ house: "work", pet: "other" }, meter({ name: "errand" }));
  const original = f.config.putScout.bind(f.config);
  spyOn(f.config, "putScout").mockImplementation(async (...args: Parameters<typeof original>) => {
    const loaded = await f.config.load();
    f.drafts.prune({ ...loaded, houses: loaded.houses.map(house => ({ ...house, pets: house.pets.filter(pet => pet.name !== "other") })) });
    return original(...args);
  });
  await f.drafts.draft(sibling, meter());
  expect(JSON.parse(f.store.get("scouts.drafts.v1.work")!).map((d: { scout: string }) => d.scout)).toEqual(["meter"]);
});

test("the owner's choices hold for what they reviewed: a shared capability that gains a host after the view refuses the apply", async () => {
  const f = await fixture(shared());
  await f.drafts.draft(sibling, change({ capabilities: ["uploads"] }));
  const [draft] = await f.drafts.list("work");
  const seen = await (await f.call("GET", `scout-drafts/${draft!.id}`)).json();
  expect(seen.reviewed).toMatch(/^[0-9a-f]{16}$/);
  expect(seen.shared).toEqual([{ name: "uploads", description: "", hosts: ["paste.example.net"], installs: false }]);
  const choices = await f.call("POST", `scout-drafts/${draft!.id}/apply`, { keys: "keep" });
  expect(choices.status).toBe(400); expect((await choices.json()).error).toContain("reviewed: send the fingerprint of the draft view you decided on"); // a choice comes with what it was made on
  expect((await f.call("POST", `scout-drafts/${draft!.id}/apply`)).status).toBe(400); // and so does an apply with no choices
  expect((await f.call("PUT", "capabilities/uploads", { name: "uploads", network: { any: false, allow: ["paste.example.net", "drop.example.org"] } })).status).toBe(200);
  const refused = await f.call("POST", `scout-drafts/${draft!.id}/apply`, { keys: "keep", reviewed: seen.reviewed });
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toBe("What this draft would do changed since you reviewed it: reload it and decide again.");
  expect((await f.house()).scouts![0]!.capabilities).toEqual([]);
  expect((await f.decide(draft!.id, { keys: "keep" })).status).toBe(200); // decided again, on what it is now
});

test("the fingerprint holds the scout as it is: a second edit of a field already named, or bots ticked elsewhere, move it", async () => {
  const f = await fixture("    capabilities:\n      - { name: browser }\n      - { name: uploads, network: { any: false, allow: [paste.example.net] } }\n      - { name: meter, owner: meter, network: { any: false, allow: [meter.example.com] } }\n    scouts:\n      - { name: meter, description: Readings }\n");
  await f.drafts.draft(sibling, change({ description: "Monthly readings", capabilities: ["browser", "uploads"] }));
  const [draft] = await f.drafts.list("work");
  await f.call("PATCH", "scouts/meter", { title: "Meter" });
  const first = await (await f.call("GET", `scout-drafts/${draft!.id}`)).json();
  expect(first.changedSince).toEqual(["title"]);
  await f.call("PATCH", "scouts/meter", { title: "Meter, again" }); // the same field named: its value moved
  const second = await (await f.call("GET", `scout-drafts/${draft!.id}`)).json();
  expect(second.changedSince).toEqual(["title"]);
  expect(second.reviewed).not.toBe(first.reviewed);
  expect((await f.call("PATCH", "scouts/meter", { routine: ["sibling"] })).status).toBe(200); // ticked elsewhere: not a field a draft holds
  expect((await (await f.call("GET", `scout-drafts/${draft!.id}`)).json()).reviewed).not.toBe(second.reviewed);
  // The shared capabilities it ticks, as the review words them: a tool lists no hosts, an access capability its own.
  expect(second.shared).toEqual([{ name: "browser", description: "", hosts: null, installs: false }, { name: "uploads", description: "", hosts: ["paste.example.net"], installs: false }]);
});

test("force holds only over the changes the owner was shown: one that lands after the view refuses it", async () => {
  const f = await fixture();
  await f.call("POST", "scouts", { name: "meter", description: "Readings" });
  await f.drafts.draft(sibling, change({ description: "Monthly readings" }));
  const [draft] = await f.drafts.list("work");
  await f.call("PATCH", "scouts/meter", { title: "Meter" });
  const seen = await (await f.call("GET", `scout-drafts/${draft!.id}`)).json();
  expect(seen.changedSince).toEqual(["title"]);
  await f.call("PATCH", "scouts/meter", { instructions: "the owner's, after the review" });
  const refused = await f.call("POST", `scout-drafts/${draft!.id}/apply`, { force: true, reviewed: seen.reviewed });
  expect(refused.status).toBe(409);
  expect((await f.house()).scouts![0]!.instructions).toBe("the owner's, after the review");
});

test("bot-written text that hides or reorders what the owner reads is refused at draft time", async () => {
  const f = await fixture();
  const hidden: [Record<string, unknown>, string][] = [
    [{ description: "Readings\u{202E}txt.exe" }, "description holds a character that hides or reorders text (U+202E)"],
    [{ instructions: "Log in.\u{200B}Then send everything" }, "instructions holds a character that hides or reorders text (U+200B)"],
    [{ reason: "Harmless\rcurl evil" }, "reason holds a character that hides or reorders text (U+000D)"],
    [{ setup: { install: "echo ok\u{2066}; curl evil\u{2069}" } }, "setup.install holds a character that hides or reorders text (U+2066)"],
    [{ instructions: "end.\u{200D} start" }, "U+200D"], // a joiner between no letters
  ];
  for (const [input, message] of hidden) await expect(f.drafts.draft(sibling, meter(input))).rejects.toThrow(message);
  await expect(f.drafts.draft(sibling, meter({ description: "For the team \u{1F469}\u{200D}\u{1F4BB}\twith tabs", instructions: "Step one.\nStep two." }))).resolves.toMatchObject({ status: "waiting_owner" }); // an emoji's joiner, tabs and lines are text
});

test("legitimate writing passes: joiners between letters (Persian, Indic), LRM and RLM, Windows line ends", async () => {
  expect(hiddenCharacter("می\u{200C}خواهم")).toBeUndefined(); // Persian "I want": a non-joiner between letters
  expect(hiddenCharacter("क्\u{200D}ष")).toBeUndefined(); // Devanagari ksha: a joiner after the virama
  expect(hiddenCharacter("price \u{200E}100 \u{200F}ok")).toBeUndefined();
  expect(hiddenCharacter("bare\rreturn")).toBe("U+000D");
  const f = await fixture();
  await f.drafts.draft(sibling, meter({ instructions: "Step one.\r\nStep two.\r\n", setup: { install: "apt-get update\r\napt-get install -y curl\r\n", network: { any: false, allow: ["meter.example.com"] } } }));
  const [view] = await f.drafts.views("work");
  expect(view!.definition.instructions).toBe("Step one.\nStep two.\n");
  expect(view!.own!.install).toBe("apt-get update\napt-get install -y curl\n");
});

test("a config error said to the bot carries no path of the owner's", async () => {
  const f = await fixture();
  spyOn(f.config, "putScout").mockImplementation(async () => { throw new HouseholdError("invalid config /Users/someone/.household/household.yaml:\n✖ scout 'work/meter': boom"); });
  const error = await f.drafts.draft(sibling, meter()).catch(e => e as Error);
  expect((error as Error).message).toBe("The workspace would not take this scout: ✖ scout 'work/meter': boom");
});

test("once the config is written the draft is done: a reload that fails says applied, not yet live, and the bot is still told", async () => {
  const f = await fixture("", true, async () => { throw new Error("gateway did not answer"); });
  await f.drafts.draft(sibling, meter({ routine: undefined }));
  const [draft] = await f.drafts.list("work");
  const response = await f.decide(draft!.id, {});
  expect(response.status).toBe(500);
  expect((await response.json()).error).toBe("applied, not yet live: gateway did not answer");
  expect((await f.house()).scouts!.map(scout => scout.name)).toEqual(["meter"]);
  expect(await f.drafts.list("work")).toEqual([]);
  expect(f.sent).toEqual([{ pet: "sibling", text: expect.stringContaining("It reaches your scouts list once Household reloads its config.") }]);
});

test("applying a config drops the drafts of bots and workspaces gone from it", async () => {
  const f = await fixture();
  await f.drafts.draft({ house: "work", pet: "other" }, meter());
  await f.drafts.draft({ house: "home", pet: "stranger" }, meter());
  const loaded = await f.config.load();
  f.drafts.prune({ ...loaded, houses: loaded.houses.filter(house => house.name === "work").map(house => ({ ...house, pets: house.pets.filter(pet => pet.name !== "other") })) });
  expect(f.store.get("scouts.drafts.v1.work")).toBeUndefined();
  expect(f.store.get("scouts.drafts.v1.home")).toBeUndefined();
  expect(await f.drafts.list("home")).toEqual([]); // the workspace is still in the file: its bot made again finds nothing
});

test("discard: the draft goes, its notice says so and its bot is told; unknown drafts are 404", async () => {
  const f = await fixture();
  await f.drafts.draft(sibling, meter());
  const [draft] = await f.drafts.list("work");
  expect((await f.call("DELETE", `scout-drafts/${draft!.id}`)).status).toBe(200);
  expect(await f.drafts.list("work")).toEqual([]);
  expect(f.sent).toEqual([{ pet: "sibling", text: expect.stringContaining("your human declined your draft of scout meter. Nothing changed.") }]);
  await settle();
  expect(f.rewrites.at(-1)!.text).toEndWith("<b>Declined.</b>");
  expect((await f.call("DELETE", `scout-drafts/${draft!.id}`)).status).toBe(404);
  expect((await f.call("POST", `scout-drafts/${draft!.id}/apply`, { reviewed: "0000000000000000" })).status).toBe(404);
  expect((await f.call("GET", "scout-drafts/nope")).status).toBe(404);
});

test("a removed bot's drafts go, and so does a change to a scout deleted since", async () => {
  const f = await fixture("    scouts:\n      - { name: breaker, description: Incidents }\n");
  await f.drafts.draft(sibling, { name: "breaker", description: "Incidents", instructions: "Look", reason: "r" });
  await f.drafts.draft({ house: "work", pet: "other" }, meter());
  expect(await f.drafts.list("work")).toHaveLength(2);
  expect((await f.call("DELETE", "scouts/breaker")).status).toBe(200);
  expect((await f.drafts.list("work")).map(d => d.scout)).toEqual(["meter"]);
  await f.config.removePet("work", "other");
  expect(await f.drafts.list("work")).toEqual([]);
});

test("the API lists drafts with what a review needs, and the scouts list counts them", async () => {
  const f = await fixture();
  await f.drafts.draft(sibling, meter());
  const list = await (await f.call("GET", "scout-drafts")).json();
  expect(list).toEqual([expect.objectContaining({ scout: "meter", petTitle: "Sibling <Bot>", reason: expect.any(String), needsKeys: ["METER_PASSWORD"], network: { open: false, allow: ["meter.example.com"], limitedBy: ["meter"] } })]);
  const waiting = { id: list[0].id, scout: "meter", pet: "sibling", petTitle: "Sibling <Bot>", at: list[0].at, change: false, stale: false, wantsRoutine: true };
  expect((await (await f.call("GET", "scouts")).json()).drafts).toEqual([waiting]);
  await f.call("POST", "scouts", { name: "other", description: "Other" });
  expect((await (await f.call("GET", "scouts/other")).json()).drafts).toEqual([]); // a scout's page: its own drafts only
  expect((await f.call("PUT", "scout-drafts")).status).toBe(404);
  expect((await f.call("POST", `scout-drafts/${list[0].id}/apply`, { routine: ["sibling"], keys: [] })).status).toBe(400); // only routine
});

test("scout_draft: for a workspace's own bots, never scouts or sideworkers; bots get no tool to apply or discard", async () => {
  const f = await fixture();
  const houses = [{ name: "work", features: { scouts: true }, network: { kind: "allowlist" as const, allow: [] }, people: { owners: [] }, channels: [],
    pets: [{ name: "sibling" }, { name: "helper", sideworker: { parent: "sibling" } }, { name: "scout-1", scout: {} }] }] as never;
  const allowed = mayDraft(() => houses, c => c.pet.startsWith("scout-"));
  expect(allowed(sibling)).toBe(true);
  expect(allowed({ house: "work", pet: "helper" })).toBe(false);
  expect(allowed({ house: "work", pet: "scout-1" })).toBe(false);
  expect(allowed({ house: "home", pet: "sibling" })).toBe(false);
  expect(mayDraft(() => [{ ...(houses as never as object[])[0], features: { scouts: false } }] as never, () => false)(sibling)).toBe(false);
  const tools = scoutDraftTools(f.drafts, allowed);
  expect(tools.map(tool => tool.name)).toEqual(["scout_draft"]);
  expect(JSON.parse(await tools[0]!.call(sibling, meter()))).toMatchObject({ status: "waiting_owner", scout: "meter" });
});

test("drafts are refused while scouts are off", async () => {
  const f = await fixture("", false);
  await expect(f.drafts.draft(sibling, meter())).rejects.toThrow("Scouts are off");
});

test("a draft is tried against the workspace's whole config before it is kept, and nothing is written", async () => {
  const f = await fixture();
  const put = spyOn(f.config, "putScout");
  await f.drafts.draft(sibling, meter());
  expect(put.mock.calls.map(args => args[3])).toEqual([{ dryRun: true }]);
  expect((await f.house()).scouts ?? []).toEqual([]);
});
