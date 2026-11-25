import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FIRST_DECISION, ScoutDraftPage, ScoutDrafts, ScoutDraftsWaiting, draftApplyBlockers, draftApplyBody, draftRefusal, hostWords, lineCount, newHosts, reconcileDecision, type DraftDecision } from "./components/scout-drafts";
import { ScoutCard, ScoutDetailPage, ScoutsPage } from "./components/scouts";
import { routeOf, scoutDraftPath, scoutPath } from "./router";
import type { WorkspaceView } from "./api";
import { scoutDraftApi, type ScoutDraftSummary, type ScoutDraftView, type ScoutView } from "./scout-api";

const house: WorkspaceView = { name: "work", owners: [], pets: [{ name: "sibling", title: "Sibling", emoji: "🤖", display: "🤖 Sibling" } as WorkspaceView["pets"][number], { name: "helper", title: "Helper", emoji: "🐾", display: "🐾 Helper", sideworker: { parent: "sibling", cwd: "/w" } } as WorkspaceView["pets"][number]], channels: [], allow: [], features: { scouts: true, preview: false, sideworkers: true } };
const noop = async () => {};
/** A change to scout meter: a bot ticks `uploads`, which reaches a host the scout did not, while its own setup holds a key in its VM. */
const view = (extra: Partial<ScoutDraftView> = {}): ScoutDraftView => ({
  id: "d1", scout: "meter", pet: "sibling", petTitle: "🤖 Sibling", at: Date.now() - 5 * 60_000, change: true, stale: false, wantsRoutine: true,
  reason: "Uploads the receipt <b>too</b>", changedSince: [],
  definition: { name: "meter", title: "Meter reader", emoji: "📟", description: "Submits the reading", instructions: "Log in.\nSubmit.", capabilities: ["uploads"] },
  own: null, current: { name: "meter", title: "Meter reader", emoji: "📟", description: "Submits the reading", instructions: "Log in.", capabilities: [], routine: ["sibling"] },
  currentOwn: { name: "meter", description: "", install: "apt-get install -y curl", network: { any: false, allow: ["meter.example.com"] }, keys: [{ secret: "meter-pass", via: "vm", env: "METER_PASSWORD" }] },
  keys: [{ env: "METER_PASSWORD", secret: "meter-pass", source: "own setup", via: "vm" }], ownChanges: [],
  vmKeyNote: "A key whose value is inside the scout's VM can reach every host the scout reaches, not only its own capability's.",
  keyGate: { keys: [{ env: "METER_PASSWORD", secret: "meter-pass", source: "own setup", via: "vm" }], reasons: ["it would reach new hosts: paste.example.net"], choices: ["keep", "drop"] },
  needsKeys: ["METER_USER"], network: { open: false, allow: ["meter.example.com", "paste.example.net"], limitedBy: ["uploads", "meter"] },
  currentNetwork: { open: false, allow: ["meter.example.com"], limitedBy: ["meter"] }, routineBlocker: null, problems: [],
  shared: [{ name: "uploads", description: "Paste site", hosts: ["paste.example.net"], installs: true }], reviewed: "fp1", ...extra,
});
const decide = (extra: Partial<DraftDecision> = {}): DraftDecision => ({ ...FIRST_DECISION, ...extra });
const page = (extra: Partial<ScoutDraftView> = {}) => renderToStaticMarkup(<ScoutDraftPage house={house} id="d1" refresh={noop} notify={() => {}} initial={view(extra)} />);

test("a draft's review has its own path under Scouts → Drafts; a scout named drafts keeps its pages", () => {
  expect(scoutDraftPath("work", "d1")).toBe("/workspaces/work/scouts/drafts/d1");
  expect(routeOf("/workspaces/work/scouts/drafts/d1")).toEqual({ page: "scout-draft", workspace: "work", draft: "d1" });
  expect(routeOf(scoutPath("work", "drafts"))).toEqual({ page: "scout", workspace: "work", scout: "drafts", tab: "overview" });
  expect(routeOf(scoutPath("work", "drafts", "access"))).toEqual({ page: "scout", workspace: "work", scout: "drafts", tab: "access" });
});

test("new hosts: those the scout does not reach now; opening it counts; a new scout marks none", () => {
  expect(newHosts(view())).toEqual({ opens: false, hosts: ["paste.example.net"] });
  expect(newHosts(view({ network: { open: true, allow: [], limitedBy: [] } }))).toEqual({ opens: true, hosts: [] });
  expect(newHosts(view({ currentNetwork: { open: true, allow: [], limitedBy: [] } }))).toEqual({ opens: false, hosts: [] });
  expect(newHosts(view({ currentNetwork: null }))).toEqual({ opens: false, hosts: [] });
});

test("Apply waits for every decision the draft needs: the keys at stake, confirming a stale draft, the bots ticked", () => {
  expect(draftApplyBlockers(view(), decide())).toEqual(["Choose what happens to the keys at stake."]);
  expect(draftApplyBlockers(view(), decide({ keys: "keep" }))).toEqual([]);
  const sharedOnly = view({ keyGate: { keys: [], reasons: ["added capability datadog brings DD_API_KEY"], choices: ["keep"] } });
  expect(draftApplyBlockers(sharedOnly, decide({ keys: "drop" }))).toEqual(["The keys at stake come with shared capabilities: keep them, or decline the draft."]);
  expect(draftApplyBlockers(view({ keyGate: null, stale: true }), decide())).toEqual(["Confirm applying it over what changed since it was drafted."]);
  expect(draftApplyBlockers(view({ keyGate: null, stale: true }), decide({ force: true }))).toEqual([]);
  expect(draftApplyBlockers(view({ keyGate: null }), decide({ routine: "bots" }))).toEqual(["Tick the bots that run it without asking, or choose Ask every time."]);
  expect(draftApplyBlockers(view({ keyGate: null, routineBlocker: "Reaches the open internet" }), decide({ routine: "bots", bots: ["sibling"] }))).toEqual(["Reaches the open internet: it cannot run without asking."]);
  expect(draftApplyBlockers(view({ keyGate: null, problems: ["unknown capability 'uploads'"] }), decide())).toEqual(["It cannot be applied as it is: unknown capability 'uploads'."]);
});

test("Apply sends what the owner decided on (the view's fingerprint, always) and only what they decided: bots in the workspace's order, never a sideworker", async () => {
  expect(draftApplyBody(view({ keyGate: null }), decide(), house.pets)).toEqual({ reviewed: "fp1" });
  expect(draftApplyBody(view(), decide({ keys: "drop" }), house.pets)).toEqual({ reviewed: "fp1", keys: "drop" });
  expect(draftApplyBody(view({ keyGate: null }), decide({ keys: "keep" }), house.pets)).toEqual({ reviewed: "fp1" }); // nothing at stake: no choice sent
  expect(draftApplyBody(view({ keyGate: null }), decide({ routine: "bots", bots: ["helper", "sibling"] }), house.pets)).toEqual({ reviewed: "fp1", routine: ["sibling"] });
  expect(draftApplyBody(view({ keyGate: null }), decide({ routine: "ask", bots: ["sibling"] }), house.pets)).toEqual({ reviewed: "fp1" }); // ticks left behind do not count
  expect(draftApplyBody(view({ keyGate: null, stale: true }), decide({ force: true }), house.pets)).toEqual({ reviewed: "fp1", force: true });
  expect(draftApplyBody(view({ keyGate: null }), decide({ force: true }), house.pets)).toEqual({ reviewed: "fp1" });
  const original = globalThis.fetch, sent: { url: string; body?: unknown }[] = [];
  globalThis.fetch = (async (url, options) => { sent.push({ url: String(url), ...(options!.body ? { body: JSON.parse(options!.body as string) } : {}) }); return Response.json({}); }) as typeof fetch;
  try { await scoutDraftApi.apply("work", "d1", { reviewed: "fp1", keys: "keep" }); } finally { globalThis.fetch = original; }
  expect(sent).toEqual([{ url: "/api/houses/work/scout-drafts/d1/apply", body: { reviewed: "fp1", keys: "keep" } }]);
});

test("choices hold only for what they were made on: a reload that moved the basis clears every choice (keys, stale confirmation, bots)", () => {
  const made = decide({ keys: "keep", force: true, routine: "bots", bots: ["sibling"] });
  expect(reconcileDecision(view(), view(), made)).toEqual(made); // nothing moved
  expect(reconcileDecision(view(), view({ reviewed: "fp2" }), made)).toEqual({ force: false, routine: "ask", bots: [] }); // every choice, the bots too
  expect(reconcileDecision(view(), view({ routineBlocker: "Reaches the open internet" }), made)).toEqual({ force: false, routine: "ask", bots: [] });
  // A gate that appeared after the page loaded asks for its choice; one that went leaves no choice behind.
  const appeared = reconcileDecision(view({ keyGate: null }), view({ reviewed: "fp2" }), decide());
  expect(draftApplyBlockers(view({ reviewed: "fp2" }), appeared)).toEqual(["Choose what happens to the keys at stake."]);
  const gone = reconcileDecision(view(), view({ keyGate: null, reviewed: "fp2" }), decide({ keys: "drop" }));
  expect(gone.keys).toBeUndefined();
  expect(draftApplyBody(view({ keyGate: null, reviewed: "fp2" }), gone, house.pets)).toEqual({ reviewed: "fp2" });
});

test("a refusal shows next to the decision it is about; applied but not live is no refusal", () => {
  expect(draftRefusal("This change puts keys whose value is in the scout's VM at stake (METER_PASSWORD): …")).toEqual({ at: "keys", applied: false });
  expect(draftRefusal("DD_API_KEY comes with capability datadog: a key of a shared capability cannot be dropped from one scout. …")).toEqual({ at: "keys", applied: false });
  expect(draftRefusal("Scout meter changed since it was drafted: instructions. …")).toEqual({ at: "stale", applied: false });
  expect(draftRefusal("Scout meter changed while the draft was being applied; nothing was written. Review it again.")).toEqual({ at: "stale", applied: false });
  expect(draftRefusal("ghost is not a bot of this workspace")).toEqual({ at: "routine", applied: false });
  expect(draftRefusal("Reaches the open internet, so meter cannot run without asking. …")).toEqual({ at: "routine", applied: false });
  expect(draftRefusal("applied, not yet live: gateway did not answer")).toEqual({ at: "apply", applied: true });
  expect(draftRefusal("No key is at stake in this draft: apply it without keep")).toEqual({ at: "apply", applied: false });
  expect(draftRefusal("What this draft would do changed since you reviewed it: reload it and decide again.")).toEqual({ at: "apply", applied: false });
});

test("the review, top to bottom: what it is for, what it runs, where it can go, what it holds, who runs it; then the actions", () => {
  const html = page();
  const order = ["What it is for", "What it runs", "Where it can go", "What it holds", "Who runs it", "Decline…"].map(text => html.indexOf(text));
  expect(order.every(at => at > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(html).toContain("Why, in 🤖 Sibling’s words");
  expect(html).toContain("Uploads the receipt &lt;b&gt;too&lt;/b&gt;"); // the bot's words, escaped
  expect(html).toContain("A bot wrote this: read it as its claim, not as Household’s.");
  expect(html).toContain("<span class=\"hint\">Now</span><span class=\"hint\">1 line</span><pre class=\"command-output tall\">Log in.</pre><span class=\"hint\">Proposed</span><span class=\"hint\">2 lines</span>"); // instructions, before and after, each with its length
  expect(html).toContain("Title<span class=\"faint\"> · proposed by 🤖 Sibling</span>");
  expect(html).toContain("Description<span class=\"faint\"> · proposed by 🤖 Sibling</span>");
  expect(html).toContain("only paste.example.net · its install script is yours, as it is now"); // every ticked capability, with its hosts
  expect(html).toContain("Its own setup stays as it is.");
  expect(html).toContain("🔒 Network: only <span><code>meter.example.com</code></span><span>, <code>paste.example.net</code> <span class=\"tag busy\">new</span></span>");
  expect(html.match(/>new</g)).toHaveLength(1);
  expect(html).toContain("Now: only meter.example.com");
  expect(html).toContain("own setup · value in its VM");
  expect(html).toContain("can reach every host the scout reaches");
  expect(html).toContain("METER_USER");
  expect(html).toContain('href="/workspaces/work/scouts/meter/access"');
  expect(html).toContain("Keys at stake: METER_PASSWORD.</span> It would reach new hosts: paste.example.net.");
  expect(html).not.toMatch(/checked="" value="(keep|drop)"/); // no key choice preselected
  expect(html).toContain("Apply change</button>");
  expect(html).toMatch(/<button type="button" class="btn primary" disabled="">Apply change/); // until the keys are decided
});

test("who runs it: Ask every time preselected, no bot ticked even when the bot asked and the scout was routine; what applying ends is said", () => {
  const html = page();
  expect(html).toContain('checked="" value="ask"');
  expect(html).not.toContain('checked="" value="bots"');
  expect(html).not.toContain('type="checkbox" checked=""');
  expect(html).toContain("🤖 Sibling asks to run it without asking. Only you decide that.");
  expect(html).toContain("Now it runs without asking for 🤖 Sibling. Applying makes it ask every time unless you tick them again.");
  expect(html).toContain("A routine scout does whatever these bots tell it, with its access.");
  const blocked = page({ routineBlocker: "Reaches the open internet", keyGate: null });
  expect(blocked).toContain("Reaches the open internet. Its bots ask you every time.");
  expect(blocked).toContain("Not possible: reaches the open internet.");
});

test("a shared capability's keys at stake: keep is the only choice, and leaving them out means unticking the capability", () => {
  const html = page({ keyGate: { keys: [{ env: "DD_API_KEY", secret: "dd", source: "datadog", via: "vm" }], reasons: ["added capability datadog brings DD_API_KEY"], choices: ["keep"] } });
  expect(html).toContain('value="keep"');
  expect(html).not.toContain('value="drop"');
  expect(html).toContain("to leave them out, decline this draft and ask 🤖 Sibling for one without those capabilities");
});

test("a stale draft: a banner with what changed, and a separate confirmation before Apply", () => {
  const html = page({ stale: true, changedSince: ["capabilities", "own setup's network"], keyGate: null });
  expect(html).toContain("The scout changed since this was drafted: capabilities, own setup&#x27;s network. Applying the draft undoes that.");
  expect(html).toContain("Apply anyway, over what changed since it was drafted");
  expect(html).not.toMatch(/type="checkbox" checked=""/);
  expect(html).toMatch(/class="btn primary" disabled="">Apply change/);
  expect(renderToStaticMarkup(<ScoutDraftPage house={house} id="d1" refresh={noop} notify={() => {}} initial={view({ keyGate: null, wantsRoutine: false })} />)).toMatch(/<button type="button" class="btn primary">Apply change/);
});

test("a new scout's review: no before, nothing marked new; its own setup in full (description, install script with its length, network); each shared capability with its hosts", () => {
  const html = page({ change: false, current: null, currentOwn: null, currentNetwork: null, keyGate: null, keys: [], vmKeyNote: null, own: { name: "meter", description: "Meter reader's own", install: "apt-get install -y curl\ncurl -d @receipt https://meter.example.com", network: { any: false, allow: ["meter.example.com"] } },
    shared: [{ name: "browser", description: "", hosts: null, installs: true }, { name: "uploads", description: "", hosts: ["paste.example.net"], installs: false }] });
  expect(html).toContain("Meter reader&#x27;s own");
  expect(html).toContain("<span class=\"hint\">2 lines</span><pre class=\"command-output tall\">apt-get install -y curl");
  expect(html).toContain("Its own setup&#x27;s network<span class=\"faint\"> · proposed by 🤖 Sibling</span></span><span>only meter.example.com</span>");
  expect(html).toContain("no network limit of its own · its install script is yours, as it is now");
  expect(html).toContain("only paste.example.net · nothing to install");
  expect(html).toContain("a new scout, <span class=\"mono\">meter</span>");
  expect(html).not.toContain(">Now<");
  expect(html).not.toContain(">new<");
  expect(html).toContain("curl -d @receipt https://meter.example.com</pre>");
  expect(html).toContain("Create scout</button>");
  expect(html).not.toContain("can reach every host");
});

test("drafts waiting: listed on the Scouts page, marked on the scout's card and named on its page", () => {
  const drafts: ScoutDraftSummary[] = [{ id: "d1", scout: "meter", pet: "sibling", petTitle: "🤖 Sibling", at: Date.now(), change: true, stale: true, wantsRoutine: true }, { id: "d2", scout: "fresh", pet: "sibling", petTitle: "🤖 Sibling", at: Date.now(), change: false, stale: false, wantsRoutine: false }];
  const list = renderToStaticMarkup(<ScoutDrafts house="work" drafts={drafts} />);
  expect(list).toContain(">Drafts<");
  expect(list).toContain('href="/workspaces/work/scouts/drafts/d1"');
  expect(list).toContain("proposes a change to <span class=\"mono\">meter</span>");
  expect(list).toContain("proposes a new scout, <span class=\"mono\">fresh</span>");
  expect(list.match(/>Stale</g)).toHaveLength(1);
  expect(list.match(/>Asks to run without asking</g)).toHaveLength(1);
  expect(renderToStaticMarkup(<ScoutDrafts house="work" drafts={[]} />)).toBe("");
  const scout = { name: "meter", description: "Readings", instructions: "", capabilities: [], own: null, network: { open: true, allow: [], limitedBy: [] }, keysInVm: [], problems: [] } as ScoutView;
  const scoutsPage = renderToStaticMarkup(<ScoutsPage house={house} agents={[]} keys={[]} refresh={noop} notify={() => {}} initial={{ scouts: [scout], capabilities: [], runs: [], limits: { cpus: 2, memoryMiB: 2048 }, agent: null, drafts }} />);
  expect(scoutsPage).toContain(">Drafts<");
  expect(scoutsPage).toContain("Draft waiting");
  expect(renderToStaticMarkup(<ScoutCard house="work" scout={scout} />)).not.toContain("Draft waiting");
  const detail = renderToStaticMarkup(<ScoutDetailPage house={house} agents={[]} keys={[]} refresh={noop} notify={() => {}} name="meter" initial={{ scout, capabilities: [], runs: [], defaults: { agent: null, limits: { cpus: 2, memoryMiB: 2048 } }, drafts: [drafts[0]!] }} />);
  expect(detail).toContain("🤖 Sibling proposes a change to this scout (stale).");
  expect(renderToStaticMarkup(<ScoutDraftsWaiting house="work" drafts={[drafts[0]!]} />)).toContain('href="/workspaces/work/scouts/drafts/d1"');
});

test("lines are counted the way a reader would", () => {
  expect(lineCount("")).toBe("0 lines");
  expect(lineCount("one\n")).toBe("1 line");
  expect(lineCount("one\ntwo")).toBe("2 lines");
});

test("a change to its own setup shows its network before and after", () => {
  const html = page({ own: { name: "meter", description: "", install: "apt-get install -y curl", network: { any: false, allow: ["meter.example.com", "paste.example.net"] } } });
  expect(html).toContain("<span class=\"hint\">Now</span><span>only meter.example.com</span><span class=\"hint\">Proposed</span><span>only meter.example.com, paste.example.net</span>");
  expect(html).toContain("Its own install script (runs as root at the start of every run)<span class=\"faint\"> · proposed by 🤖 Sibling</span><span class=\"faint\"> · unchanged</span>");
});

test("with scouts off, waiting drafts can still be read and declined; Apply says why it is not there", () => {
  const off = { ...house, features: { ...house.features!, scouts: false } };
  const html = renderToStaticMarkup(<ScoutDraftPage house={off} id="d1" refresh={noop} notify={() => {}} initial={view({ keyGate: null })} />);
  expect(html).toContain("Scouts are off in this workspace. You can read this draft and decline it");
  expect(html).toContain(">Decline…</button>");
  expect(html).toMatch(/class="btn primary" disabled="">Apply change/);
  expect(html).toContain("Scouts are off in this workspace: turn them on in its settings to apply a draft.");
  expect(draftApplyBlockers(view({ keyGate: null }), decide(), false)).toEqual(["Scouts are off in this workspace: turn them on in its settings to apply a draft."]);
  const drafts: ScoutDraftSummary[] = [{ id: "d1", scout: "meter", pet: "sibling", petTitle: "🤖 Sibling", at: Date.now(), change: false, stale: false, wantsRoutine: false }];
  const list = renderToStaticMarkup(<ScoutsPage house={off} agents={[]} keys={[]} refresh={noop} notify={() => {}} initial={{ scouts: [], capabilities: [], runs: [], limits: { cpus: 2, memoryMiB: 2048 }, agent: null, drafts }} />);
  expect(list).toContain("Turn on in Settings");
  expect(list).toContain('href="/workspaces/work/scouts/drafts/d1"');
});

test("a shared capability's hosts in words: a tool limits nothing of its own; an access capability names its hosts", () => {
  expect(hostWords(null)).toBe("no network limit of its own"); // what the view sends for network.any
  expect(hostWords([])).toBe("no network limit of its own");
  expect(hostWords(["paste.example.net", "api.example.com"])).toBe("only paste.example.net, api.example.com");
  const html = page({ shared: [{ name: "browser", description: "", hosts: null, installs: true }, { name: "uploads", description: "", hosts: ["paste.example.net"], installs: false }] });
  expect(html).toContain("no network limit of its own · its install script is yours, as it is now");
  expect(html).toContain("only paste.example.net · nothing to install");
  expect(html).not.toMatch(/only ·|only <\/span>/);
});

test("its own setup's description is labelled as that, not as the whole setup", () => {
  const html = page({ own: { name: "meter", description: "Meter reader's own", install: "v2", network: { any: false, allow: ["meter.example.com"] } }, currentOwn: { name: "meter", description: "Meter reader's own", install: "v1", network: { any: false, allow: ["meter.example.com"] }, keys: [] } });
  expect(html).toContain("Its own setup&#x27;s description<span class=\"faint\"> · unchanged</span>");
  expect(html).not.toContain(">Its own setup<");
});
