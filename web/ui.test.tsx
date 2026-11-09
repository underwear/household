import { accessWords, servicesWords } from "./components/workspace-connectors";
import { claudeCodeTmux } from "../src/agent-adapters/claude-code-tmux";
import { NETWORK_PRESETS } from "../src/core/network-presets";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { buildWebBundle } from "../src/infra/web-bundle";
import { api, type HarnessView, type WorkspaceView, type KeyView, type BotView } from "./api";
import { written } from "./components/section";
import { telegram, telegramGroup, telegramPrivate } from "../src/channel-adapters/telegram";
import { ChannelDialog, ChannelsPage } from "./components/channels";
import { Dialog, firstFocus } from "./components/dialog";
import { SelectField, TextField } from "./components/fields";
import { Cell, Cluster, FormGrid, List, ListRow, Page, Section } from "./components/layout";
import { WorkspacesTable } from "./components/workspaces";
import { KeyDialog, KeysSection } from "./components/keys";
import { AllowlistSection, TemporaryNetworkSection, allowDialog, presetDialog, revokeTemporaryDialog } from "./components/workspace";
import { OwnerDialog, OwnersSection } from "./components/owners";
import { BotDialog, BotsPage, keyLabel, effortForModel, useHarnessForm } from "./components/bots";
import { BotResources } from "./components/bot-resources";
import { WorkspaceOverviewPage } from "./components/workspace-overview";
import { BotEnvironment, TEMPLATES } from "./components/bot-environment";
import { BotDetailPage } from "./components/bot-detail";
import { SignIn } from "./components/sign-in";
import { isCurrent, routeOf } from "./router";

const TOKEN = `4242:${"A".repeat(35)}`;
const work: WorkspaceView = {
  name: "work",
  allow: [
    { host: "github.com", byAgent: false },
    { host: "db.internal:5432", byAgent: false },
    { host: "api.anthropic.com", byAgent: true },
  ],
  owners: [
    { platform: "telegram", id: "100200300", note: "Vera", problem: null },
    { platform: "telegram", id: "@oleg", note: null, problem: "'@oleg' is not a Telegram user id" },
  ],
  channels: [
    { kind: "telegram-private", platform: "telegram", label: "Telegram Bot DM (threaded)", name: "DM", ownName: "DM", note: "test bot, delete later", fields: { token: TOKEN }, shown: { token: "@my_household_bot" }, chat: "100200300", pets: ["sibling", "chair"], default: "sibling", problem: null },
    { kind: "telegram-private", platform: "telegram", label: "Telegram Bot DM (threaded)", name: "Telegram Bot DM (threaded)", ownName: null, note: null, fields: { token: "pasted wrong" }, shown: { token: null }, chat: "42", pets: [], default: null, problem: "its token is not a bot token" },
  ],
  pets: [
    { name: "sibling", title: "Sibling", ownTitle: "Sibling", display: "🦉 Sibling", emoji: "🦉", ownEmoji: "🦉", aliases: ["Sib"], agent: "claude-code-tmux", model: "opus", settings: {}, mode: "manual", key: "claude", problem: null, state: "running" },
    { name: "chair", title: "Chair", ownTitle: null, display: "🤖 Chair", emoji: "🤖", ownEmoji: null, aliases: [], agent: "claude-code-tmux", model: "gpt-9", settings: {}, mode: "bypassPermissions", key: null, problem: "unknown model 'gpt-9'", state: "missing" },
  ],
};
const agents: HarnessView[] = [
  { name: "claude-code-tmux", models: ["opus", "haiku"], defaultModel: "opus", modes: [{ id: "bypassPermissions", label: "Bypass permissions" }, { id: "manual", label: "Manual" }], defaultMode: "bypassPermissions", settings: [], providers: ["anthropic"] },
  { name: "plain", models: ["m"], defaultModel: "m", modes: [], defaultMode: null, settings: [], providers: ["anthropic"] },
  // A harness with a setting of its own (claude's subagent model): a field drawn from the description.
  { name: "tuned", models: ["opus", "haiku"], defaultModel: "opus", modes: [], defaultMode: null, providers: ["anthropic"],
    settings: [{ key: "subagentModel", label: "Subagent model", description: "What its subagents run on.", options: [{ id: "opus", label: "opus" }, { id: "haiku", label: "haiku" }], defaultLabel: "the bot's own model" }] },
];
const kinds = [telegramPrivate];
const platforms = [{ platform: telegram.platform, label: telegram.label, icon: telegram.icon, ownerId: telegram.ownerId }];
const keys: KeyView[] = [
  { name: "claude", provider: "anthropic", kind: "subscription", value: "sk-ant-oat01-ui-test", note: "Max", pets: ["work/sibling"], houses: null, allowOverage: false, allowance: null },
  { name: "gpt", provider: "openai", kind: null, value: "sk-openai-ui-test", note: null, pets: [], houses: null, allowOverage: false, allowance: null },
];
const lab: WorkspaceView = { name: "lab", allow: [], owners: [], channels: [], pets: [] };
// A 10-core, 32 GiB host; work's two bots take the defaults (2 vCPU, 1 GiB each).
const capacity = { host: { cpus: 10, memoryMiB: 32768 }, houses: [work, lab] };

/** What runs a bot, as its Harness tab and the Add bot wizard show it. */
function HarnessFields({ agents, keys = [], pet }: { agents: HarnessView[]; keys?: KeyView[]; pet?: BotView; onClose?: () => void; save?: unknown }) {
  return useHarnessForm(agents, keys, pet).fields;
}

test("dynamic model picker preserves configured IDs and explains the selected native permission mode", () => {
  const codex: HarnessView = {
    name: "codex-app-server", models: ["gpt-6.1-terra"], defaultModel: "gpt-6.1-terra", dynamicModels: true,
    providers: ["openai"], defaultMode: "auto", settings: [],
    modes: [{ id: "auto", label: "Auto" }, { id: "autoReview", label: "Approve for me", description: "A separate reviewer checks boundary requests." }],
  };
  const html = renderToStaticMarkup(<HarnessFields agents={[codex]} keys={keys}
    pet={{ ...work.pets[0]!, agent: codex.name, model: "gpt-6-astra", mode: "autoReview", key: "gpt" }} />);
  expect(html).toContain('value="gpt-6-astra" selected=""');
  expect(html).toContain("Enter model ID…");
  expect(html).toContain("Loading models…");
  expect(html).not.toContain("A separate reviewer checks boundary requests.");
});

test("the bundle builds: a page loading one script, one stylesheet and its icon, with the fonts inside, nothing from elsewhere", async () => {
  const assets = await buildWebBundle(join(import.meta.dir, "index.html"));
  const page = new TextDecoder().decode(assets.get("/index.html")!.body);
  const loaded = [...page.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]!);
  expect(loaded).toHaveLength(3);
  expect(page).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon-[a-z0-9]+\.svg"/); // hashed, served as this origin's file (the CSP's img-src)
  for (const path of loaded) expect(assets.has(path)).toBe(true);
  const css = new TextDecoder().decode([...assets].find(([path]) => path.endsWith(".css"))![1].body);
  expect(css).toContain("font-family:Onest");
  expect(css).toContain("JetBrains Mono");
  expect(css).not.toMatch(/url\(\s*["']?https?:/);
  expect(page).not.toContain("<script>"); // nothing inline: the CSP allows only this origin's files
});

test("key screens render", () => {
  const signIn = renderToStaticMarkup(<SignIn host="127.0.0.1:8780" failed />);
  expect(signIn).toContain("Sign in from your terminal");
  expect(signIn).toContain("house dashboard");
  expect(signIn).toContain("That link expired or was used");

  const table = renderToStaticMarkup(<WorkspacesTable houses={[work, lab]} platforms={platforms} />);
  expect(table).toMatch(/<span class="chip" title="🦉 Sibling · Running"><span class="dot idle" aria-label="Running"><\/span><span class="ellipsis">🦉 Sibling<\/span><\/span>/); // a bot per chip, its state as the dot
  expect(table).toContain("🤖 Chair");
  expect(table).toContain("3 hosts (1 by harness)");
  expect(table).toContain("DM · Telegram Bot DM (threaded)"); // the kind's label, not its id
  expect(table).toContain('<span class="ellipsis">Telegram Bot DM (threaded)</span>'); // one with no name of its own: the label alone
  expect(table).toContain("no channels");

  const props = { house: work, ask: () => {}, save: async () => {} };
  const allowlist = renderToStaticMarkup(<AllowlistSection {...props} />);
  expect(allowlist).toContain("db.internal:5432");
  expect(allowlist.match(/Remove/g)).toHaveLength(2); // not the harness's host
  expect(allowlist).toContain("by harness");
  const channels = renderToStaticMarkup(<ChannelsPage {...props} kinds={kinds} platforms={platforms} />);
  expect(channels).toContain("DM · Telegram Bot DM (threaded)");
  expect(channels).not.toContain("telegram-private");
  expect(channels).toContain("@my_household_bot · chat 100200300"); // what its token is (its bot), not the token itself
  expect(channels).not.toContain(TOKEN);
  expect(channels).toContain(">chat 42<"); // a token that is no bot's: nothing to say of it
  // The platform's icon on every channel row, drawn inline from its path (no image loaded).
  expect(channels.match(/<span class="avatar icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M11\.944/g)).toHaveLength(2 + work.owners.length); // and on every owner
  expect(channels).toContain('fill="currentColor"'); // monochrome, like the UI's own icons
  expect(channels).toContain("<h2 class=\"h2\">Owners</h2>"); // and the owners, on the same page
  expect(channels).toContain('aria-label="Bots: 🦉 Sibling, 🤖 Chair"'); // bots as people see them named
  expect(channels).toContain('<span class="chip default" title="Gets unaddressed messages"><span aria-hidden="true">🦉</span><span class="ellipsis">Sibling</span><span class="chip-note">default</span></span>');
  expect(channels).toContain('<button class="btn primary">+ Add channel</button>'); // the page's one primary button, in its head
  expect(channels).toContain("its token is not a bot token"); // a channel not open says why
  expect(channels.match(/>Edit</g)).toHaveLength(4); // two channels, two owners (their notes)
  expect(channels).toContain('<span class="hint">test bot, delete later</span>'); // the owner's note, under the main line
  expect(channels).toContain('<span class="strong ellipsis">Vera</span><span class="id ellipsis">Telegram · 100200300</span>'); // the owner's note names them
  const owners = renderToStaticMarkup(<OwnersSection {...props} platforms={platforms} />);
  expect(owners).toContain('<span class="strong ellipsis">Telegram</span><span class="id ellipsis">@oleg</span>'); // no note: the platform, then the id
  expect(owners).toContain('<button class="btn small">+ Add owner</button>'); // added in a dialog, like everything else
  expect(owners).toContain("&#x27;@oleg&#x27; is not a Telegram user id"); // what is wrong with an owner, at the owner
  const adding = renderToStaticMarkup(<OwnerDialog platforms={platforms} noteMax={200} onClose={() => {}} save={async () => {}} />);
  expect(adding).toMatch(/<select[^>]*><option value="telegram" selected="">Telegram<\/option><\/select>/); // the platform, even with one
  expect(adding).toMatch(/maxLength="200"/);
  const editing = renderToStaticMarkup(<OwnerDialog platforms={platforms} owner={{ platform: "telegram", id: "777", note: "Vera", problem: null }} onClose={() => {}} save={async () => {}} />);
  expect(editing).not.toContain("<select"); // only the note: another id is another owner
  expect(editing).toContain("Vera");
  expect(adding).toMatch(/<label[^>]*>Telegram user id<\/label><input[^>]*placeholder="100200300"/); // its id as the platform describes it
  expect(renderToStaticMarkup(<OwnersSection {...props} house={lab} platforms={platforms} />)).toContain("No owners.");
  const pets = renderToStaticMarkup(<BotsPage {...props} agents={agents} keys={keys} capacity={capacity} />);
  // A card per bot, opening its page; what is done to a bot is done there (no Edit or Remove here).
  expect(pets).toContain('<a href="/workspaces/work/bots/sibling" class="bot-card">');
  expect(pets).not.toMatch(/>Edit<|>Remove<|>Environment</);
  expect(pets).toContain("Running");
  expect(pets).toContain('<span class="avatar large" aria-hidden="true">🦉</span>'); // the emoji, not the first letter
  expect(pets).toContain('<span class="avatar large" aria-hidden="true">🤖</span>');
  expect(pets).toContain("Not started");
  expect(pets).toContain('<span class="ellipsis">claude-code-tmux</span><span class="bot-card-model"><span class="ellipsis" title="opus">opus</span>');
  expect(pets).toContain("unknown model &#x27;gpt-9&#x27;"); // what is wrong, on its card
  expect(pets).toContain('<span class="tag bot-card-mode" title="Permission mode">Manual</span>'); // its mode as people call it
  expect(pets).toMatch(/<span class="tag" title="Reasoning effort"><svg[^>]*>.*?<\/svg>default<\/span>/);
  expect(pets).toContain('<span class="ellipsis">DM · Telegram Bot DM (threaded)</span><span class="faint">default</span>'); // the channels it is in, default where it is
  expect(renderToStaticMarkup(<BotsPage {...props} house={{ ...work, channels: [] }} agents={agents} keys={keys} capacity={capacity} />)).toContain("In no channel");
  expect(pets).toContain("unknown model &#x27;gpt-9&#x27;"); // typed wrong in household.yaml: shown, marked
});

test("the forms render with what they edit: a channel's bots to tick and its default, a bot's harness and models", () => {
  const form = (element: React.ReactElement) => renderToStaticMarkup(element);
  // Editing starts at the kind's fields, its kind in the title, no way back to the kinds; its chat read only.
  const channel = form(<ChannelDialog house={work} kinds={kinds} channel={work.channels[0]} onClose={() => {}} save={async () => {}} />);
  expect(channel).toContain("Edit DM · Telegram Bot DM (threaded)");
  expect(channel).toMatch(/>Note<\/label><input[^>]*value="test bot, delete later"/); // the common fields' last
  // The token: a plain text field (mono) on its own row, shown in full.
  const token = /<input[^>]*placeholder="123456789:AAH4x…from @BotFather"[^>]*>/.exec(channel)![0];
  expect(token).not.toContain('type="password"');
  expect(token).toContain(`value="${TOKEN}"`);
  expect(token).toContain('class="control mono"');
  expect(token).not.toContain("data-1p-ignore");
  expect(channel).not.toContain("form-grid"); // the token and the chat each on its own row
  expect(channel).toMatch(/>Chat id<\/label><input[^>]*readOnly=""[^>]*value="100200300"/); // its chat names it: another chat is another channel
  expect(channel.match(/type="checkbox" checked=""/g)).toHaveLength(2);
  expect(channel).toContain("Default"); // two bots: a default to choose
  expect(channel).not.toContain(">Back<");
  // A new one: first its kind (label and a line on it, even with one kind), Next; then that kind's fields, with Back.
  const fresh = form(<ChannelDialog house={work} kinds={kinds} onClose={() => {}} save={async () => {}} />);
  expect(fresh).toContain("Add channel");
  expect(fresh).toMatch(/type="radio"[^>]*checked=""[^>]*value="telegram-private"/);
  expect(fresh).toContain("a thread per bot. Messages in General are ignored."); // its line, from the kind
  expect(fresh).toContain(">Next<");
  expect(fresh).not.toContain("Bot token");
  expect(renderToStaticMarkup(<ChannelDialog house={work} kinds={kinds} platforms={platforms} onClose={() => {}} save={async () => {}} />)).toContain('<span class="avatar icon small" aria-hidden="true"><svg'); // the kind's platform icon
  const second = form(<ChannelDialog house={work} kinds={kinds} kind="telegram-private" onClose={() => {}} save={async () => {}} />);
  expect(second).toContain("Add Telegram Bot DM (threaded)");
  expect(second).toContain(">Back<");
  expect(second).toContain("From @BotFather; the bot needs Threaded Mode on."); // the field's hint, from the kind
  expect(second).not.toContain("readOnly");
  expect(second).not.toContain("Default");
  // A group: its chat id with steps to find it, folded under the hint; the address in a step is a link.
  const group = form(<ChannelDialog house={work} kinds={[telegramGroup]} kind="telegram-group" onClose={() => {}} save={async () => {}} />);
  expect(group).toMatch(/>Group chat id<\/label><input[^>]*placeholder="-1001234567890"/);
  expect(group).toContain('<details class="field-help"><summary>');
  expect(group).toContain("Where do I find it?</summary><ol><li>Open ");
  expect(group).toContain('<a class="text-link" href="https://web.telegram.org/a" target="_blank" rel="noreferrer">web.telegram.org/a</a> in a browser');
  expect(second).not.toContain("field-help"); // a field without steps has no fold
  const pet = form(<BotDialog agents={agents} pet={{ ...work.pets[1]!, model: "haiku", problem: null }} onClose={() => {}} save={async () => {}} />);
  expect(pet).toContain("Edit 🤖 Chair");
  expect(pet).not.toContain(">Name<"); // a bot's name stays
  expect(pet).not.toContain("<select"); // what runs it and its size have their own tabs
  expect(form(<HarnessFields agents={agents} pet={{ ...work.pets[1]!, model: "haiku", problem: null }} />)).toContain('<option value="haiku" selected="">haiku</option>');
  const owl = form(<BotDialog agents={agents} pet={work.pets[0]!} onClose={() => {}} save={async () => {}} />);
  expect(owl).toMatch(/<label[^>]*>Emoji<\/label><input[^>]*placeholder="🤖"[^>]*value="🦉"/); // its own, the default as the hint
  expect(form(<BotDialog agents={agents} pet={work.pets[1]!} onClose={() => {}} save={async () => {}} />)).toMatch(/placeholder="🤖"[^>]*value=""/);
  const wizard = form(<BotDialog agents={agents} keys={keys} house={work} capacity={capacity} onClose={() => {}} save={async () => {}} />);
  expect(wizard).toContain('<li class="current" aria-current="step">Bot</li><li>Harness</li><li>Resources</li>'); // three steps, the first one now
  expect(wizard).toContain(">Display name<");
  expect(wizard).toContain(">Next<");
  // The channels it joins, on the first step: the workspace's, none ticked when there are several to choose from.
  expect(wizard).toContain('<legend class="field-label">Channels</legend>');
  expect(wizard).toContain("<span>DM · Telegram Bot DM (threaded)</span>");
  expect(wizard).not.toMatch(/type="checkbox" checked=""/);
  const only = form(<BotDialog agents={agents} keys={keys} house={{ ...work, channels: [work.channels[0]!] }} capacity={capacity} onClose={() => {}} save={async () => {}} />);
  expect(only).toMatch(/<input type="checkbox" checked=""\/><span>DM · Telegram Bot DM \(threaded\)<\/span>/); // the only one: ticked already
  expect(form(<BotDialog agents={agents} keys={keys} house={lab} capacity={capacity} onClose={() => {}} save={async () => {}} />)).toContain("No channels in lab yet. Add one on the workspace&#x27;s Channels page");
  const newBot = form(<HarnessFields agents={agents} keys={keys} />);
  expect(newBot).toContain('<option value="opus" selected="">opus</option>'); // the harness's default
  // Its permission mode, the harness's default selected, named as people call it; a harness without modes has no field.
  expect(newBot).toMatch(/<label[^>]*>Permission mode<\/label>/);
  expect(newBot).not.toContain("How much it may do without asking");
  expect(newBot).toContain('<option value="bypassPermissions" selected="">Bypass permissions</option><option value="manual">Manual</option>');
  expect(form(<HarnessFields agents={agents} pet={work.pets[0]} />)).toContain('<option value="manual" selected="">Manual</option>');
  const odd = form(<HarnessFields agents={agents} pet={{ ...work.pets[0]!, mode: "yolo" }} />);
  expect(odd).toContain('<option value="yolo" disabled="" selected="">yolo (unknown)</option>'); // the config's, not the harness's
  expect(form(<HarnessFields agents={agents} pet={{ ...work.pets[1]!, agent: "plain", model: "m", mode: null, problem: null }} />)).not.toContain(">Permission mode<");
  // Its key: the keys of a provider its harness takes (not openai's); the only one there is, chosen already (and saved so).
  expect(newBot).toMatch(/<select[^>]*><option value="claude" selected="">claude \(subscription\) — Max<\/option><\/select>/);
  const several = [...keys, { ...keys[0]!, name: "api", kind: "API key", note: null, pets: [] }];
  expect(form(<HarnessFields agents={agents} keys={several} />)).toContain('<option value="" disabled="" selected="">Choose a key…</option><option value="claude">claude (subscription) — Max</option>');
  const pinned = form(<HarnessFields agents={agents} keys={several} pet={{ ...work.pets[0]!, key: "api" }} />);
  expect(pinned).toMatch(/<select[^>]*><option value="claude">claude \(subscription\) — Max<\/option><option value="api" selected="">api \(API key\)<\/option><\/select>/);
  expect(form(<HarnessFields agents={agents} keys={[]} />)).toContain("No anthropic key yet (add one under Keys)");
});

test("the Keys section: each key's name, provider, kind, value masked (first five characters), note and bots; its form", () => {
  const page = renderToStaticMarkup(<KeysSection keys={keys} houses={["work"]} providers={["anthropic", "openai"]} refresh={async () => {}} notify={() => {}} />);
  expect(page).toContain("anthropic · subscription");
  expect(page).toContain("openai · unknown kind");
  expect(page).toContain('<span class="id">sk-an••</span>');
  expect(page).not.toContain("sk-ant-oat01-ui-test"); // whole only on Reveal
  expect(page).toContain('<span class="label">Used in</span><span><span class="strong">work</span> · sibling</span>');
  expect(page).toContain("Not used by any bot.");
  expect(page).toContain('<span class="hint">Max</span>');
  const form = renderToStaticMarkup(<KeyDialog providers={["anthropic", "openai"]} noteMax={200} keyView={keys[0]} onClose={() => {}} save={async () => {}} />);
  expect(form).toContain("Edit key claude");
  expect(form).not.toContain(">Name<"); // a key's name stays
  expect(form).toMatch(/<input[^>]*class="control mono"[^>]*value="sk-ant-oat01-ui-test"/);
  expect(form).toMatch(/maxLength="200"[^>]*value="Max"/);
  expect(routeOf("/settings")).toEqual({ page: "settings" });
  expect(routeOf("/keys")).toEqual({ page: "redirect", to: "/settings" });
});

test("a dialog's first focus: its first field you can change, else its submit button; on touch, no keyboard", () => {
  const control = (tagName: string, more: { type?: string; name?: string; readOnly?: boolean; disabled?: boolean } = {}) => ({ tagName, ...more });
  const form = control("FORM");
  const name = control("INPUT", { type: "text" });
  const agent = control("SELECT");
  const cancel = control("BUTTON", { type: "button", name: "cancel" });
  const submit = control("BUTTON", { type: "submit" });
  expect(firstFocus([name, control("INPUT", { type: "text" }), agent, cancel, submit], form, false)).toBe(name); // Name, not the select
  expect(firstFocus([control("INPUT", { type: "text", readOnly: true }), control("INPUT", { disabled: true }), agent, cancel, submit], form, false)).toBe(agent);
  expect(firstFocus([cancel, submit], form, false)).toBe(submit); // a confirmation
  expect(firstFocus([name, cancel, submit], form, true)).toBe(form); // touch: a field would open the keyboard
  expect(firstFocus([cancel, submit], form, true)).toBe(submit);
  expect(firstFocus([cancel, submit], form, false, true)).toBe(cancel); // a safe one: Cancel
  expect(firstFocus([cancel, submit], form, true, true)).toBe(cancel);
  // The fields come in that order in the forms, and nothing else claims the focus.
  const pet = renderToStaticMarkup(<BotDialog agents={agents} house={lab} capacity={capacity} onClose={() => {}} save={async () => {}} />);
  expect(pet).toContain('placeholder="my_bot"'); // the wizard starts with its name
  expect(pet).not.toContain("<select");
  expect(pet).not.toContain("autofocus");
});

test("the primitives render: page, section, cluster, form grid, list rows that reflow, one field system", () => {
  const page = renderToStaticMarkup(
    <Page title="Workspaces" actions={<button>New</button>}>
      <Section title="Bots" hint="One line." actions={<button>Add</button>}>
        <Cluster justify="between">
          <span>a</span>
        </Cluster>
        <FormGrid>
          <TextField label="Name" mono hint="Lower-case." value="lab" onChange={() => {}} />
          <SelectField label="Harness" value="b" onChange={() => {}} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />
        </FormGrid>
        <List columns="1fr auto" head={["Name", ""]} empty="Nothing.">
          <ListRow actions={<button>Edit</button>}>
            <Cell>one</Cell>
            <Cell label="Bots">two</Cell>
          </ListRow>
          <ListRow>
            <Cell mono>alone</Cell>
          </ListRow>
        </List>
        <List empty="Nothing." />
      </Section>
    </Page>,
  );
  expect(page).toContain('<h1 class="h1" tabindex="-1">Workspaces</h1>'); // focusable: the focus goes there after moving
  expect(page).toContain('<h2 class="h2">Bots</h2>');
  expect(page).toContain('class="cluster gap-3 between"');
  expect(page).toContain('class="form-grid"');
  expect(page).toContain('role="table" style="--cols:1fr auto"');
  expect(page).toContain('<span role="columnheader">Name</span>'); // read out on a phone too
  expect(page).toContain('<div class="list-row list-head" role="row">'); // not hidden from screen readers
  expect(page.match(/class="list-row reflow"/g)).toHaveLength(1); // several cells: stacks on a phone; one cell stays a line
  expect(page).toContain('data-label="Bots"');
  expect(page).toContain('<div class="list-empty" role="row"><span role="cell">Nothing.</span></div>');
  // One control class for inputs and selects; mono only where asked; the label and hint tied to the control.
  const id = /<label for="([^"]+)" class="field-label">Name<\/label>/.exec(page)![1]!;
  expect(page).toContain(`id="${id}" aria-describedby="${id}-hint"`);
  expect(page).toContain('class="control mono"');
  expect(page).toMatch(/<select[^>]*class="control"/);
  expect(page).toContain("chevron");
});

test("media queries use only the breakpoints of tokens.css", () => {
  const folder = join(import.meta.dir, "styles");
  for (const file of readdirSync(folder)) {
    const css = readFileSync(join(folder, file), "utf8");
    for (const [query] of css.matchAll(/@media[^{]+/g)) {
      for (const [width] of query.matchAll(/\d+px/g)) expect(["600px", "1024px"]).toContain(width);
    }
  }
});

test("routes: a workspace's pages by its name, its own path its first page; anything else is a missing page", () => {
  expect(routeOf("/workspaces/work")).toEqual({ page: "workspace", name: "work", tab: "overview" });
  expect(routeOf("/workspaces/work/bots/sibling")).toEqual({page: "bot", workspace: "work", bot: "sibling", tab: "overview"});
  expect(routeOf("/workspaces/work/bots/sibling/tasks")).toEqual({page: "bot", workspace: "work", bot: "sibling", tab: "tasks"});
  expect(routeOf("/workspaces/work/bots/sibling/environment")).toEqual({page: "bot", workspace: "work", bot: "sibling", tab: "environment"});
  expect(routeOf("/workspaces/work/bots/sibling/overview")).toEqual({page: "missing"}); // the overview is the bot's own path
  expect(routeOf("/workspaces/l%C3%A4b/bots/a%20b")).toEqual({page: "bot", workspace: "läb", bot: "a b", tab: "overview"});
  for (const tab of ["bots", "channels", "network", "settings"] as const) expect(routeOf(`/workspaces/work/${tab}`)).toEqual({ page: "workspace", name: "work", tab });
  expect(routeOf("/workspaces/work/gateway")).toEqual({ page: "missing" }); // said so, not the workspaces
  expect(routeOf("/")).toEqual({ page: "workspaces" });
  expect(routeOf("/nope")).toEqual({ page: "missing" });
  expect(routeOf("/workspaces/l%C3%A4b/channels/")).toEqual({ page: "workspace", name: "läb", tab: "channels" });
  expect(routeOf("/workspaces/%E0%A4%A")).toEqual({ page: "missing" }); // not decodable
  expect(isCurrent("/", "/")).toBe(true);
  expect(isCurrent("/", "/workspaces/work")).toBe(false); // the root only on itself
  expect(isCurrent("/workspaces/work", "/workspaces/work/bots/sibling")).toBe(true);
  expect(isCurrent("/workspaces/work", "/workspaces/workshop")).toBe(false);
});

test("a write the daemon saved but could not apply is done, with a warning; any other failure is an error", async () => {
  const realFetch = globalThis.fetch;
  const answer = (status: number, error: string) =>
    (globalThis.fetch = (async () => Response.json({ error }, { status })) as unknown as typeof fetch);
  try {
    answer(500, "saved in household.yaml, but the daemon could not apply it: see its log");
    expect(await written(api.addOwner("work", "telegram", "7"))).toBe("saved in household.yaml, but the daemon could not apply it: see its log");
    answer(400, "is not a person's id");
    await expect(written(api.addOwner("work", "telegram", " "))).rejects.toThrow("is not a person's id");
    answer(500, "internal error: see the daemon's log");
    await expect(written(api.addOwner("work", "telegram", "7"))).rejects.toThrow("internal error");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a key in the bot form's select: name, kind, then the start of its note", () => {
  expect(keyLabel({ name: "claude", kind: "subscription", provider: "anthropic" })).toBe("claude (subscription)");
  expect(keyLabel({ name: "claude", kind: "subscription", provider: "anthropic", note: "Max" })).toBe("claude (subscription) — Max");
  expect(keyLabel({ name: "api", kind: null, provider: "anthropic", note: "the team's API key, billed to the company card" })).toBe("api (anthropic) — the team's API key, billed to t…");
});

test("the allowlist: format help, a whole-internet row marked, its confirmation safe by default", () => {
  const open: WorkspaceView = { ...lab, allow: [{ host: "*", byAgent: false }, { host: "*:*", byAgent: false }, { host: "*.github.com", byAgent: false }] };
  const section = renderToStaticMarkup(<AllowlistSection house={open} ask={() => {}} save={async () => {}} />);
  expect(section.match(/<span class="tag danger">whole internet<\/span>/g)).toHaveLength(2); // not *.github.com
  expect(section.match(/>Remove</g)).toHaveLength(3); // marked, still removable
  expect(section).toContain("<dt><code>*</code></dt><dd>any public host");
  expect(section).toContain("Domain formats");
  expect(section).toContain("TCP port 443 (HTTPS) by default");
  expect(section).toContain("<dt><code>example.com:80</code></dt><dd>HTTP");
  expect(section).toContain("<code>example.com:22</code> — SSH");
  expect(section).not.toContain('class="chip button mono"');

  const dialog = (host: string) => renderToStaticMarkup(<Dialog spec={allowDialog("work", host, async () => {})} onClose={() => {}} />);
  const whole = dialog("*");
  expect(whole).toContain("Open the whole internet to bots in work?");
  expect(whole).toContain("any public host on port 443");
  expect(whole).toContain("Your local network and the machine Workspace runs on stay closed.");
  expect(whole).not.toContain("Mac");
  // Cancel is the primary button (and the first focus), first in the DOM; the risk is the second, danger-styled one.
  expect(whole).toMatch(/<div class="dialog-foot safe"><button type="button" class="btn primary" name="cancel">Cancel<\/button><button type="submit" class="btn danger">I understand the risk<\/button>/);
  expect(dialog("*:*")).toContain("any public host on any port");
  expect(dialog("*:8080")).toContain("any public host on port 8080");
  for (const host of ["github.com", "*.github.com"]) {
    const plain = dialog(host);
    expect(plain).toContain(`Allow ${host}?`);
    expect(plain).toMatch(/<button type="button" class="btn" name="cancel">Cancel<\/button><button type="submit" class="btn primary">Allow<\/button>/);
  }
});

test("temporary network access shows its bot, reason and remaining lifetime separately from the permanent list", () => {
  const html = renderToStaticMarkup(<TemporaryNetworkSection
    house={{ ...work, temporary: [443, 22].map((port) => ({ house: "work", pet: "sibling", domain: "api.github.com", port, addresses: ["140.82.112.6"], reason: "GitHub issue lookup", expiresAt: Date.now() + 14 * 60_000 })) }}
    ask={() => {}} save={async () => {}}
  />);
  expect(html).toContain("Temporary access");
  expect(html).toContain("api.github.com:443");
  expect(html).toContain("api.github.com:22");
  expect(html.match(/>Revoke</g)).toHaveLength(2);
  expect(html).toContain("one host and port, for one bot, at the addresses shown, for 15 minutes");
  expect(html).toContain("140.82.112.6");
  expect(html).toContain("GitHub issue lookup");
  expect(html).toContain("min left");
  expect(html).toContain("Revoke");
  expect(html).not.toContain("db.internal");
});

test("temporary grant revocation confirms and sends only the selected bot's endpoint", async () => {
  const realFetch = globalThis.fetch;
  const requests: { url: string; method: string | undefined }[] = [];
  try {
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), method: init?.method });
      return Response.json({});
    }) as typeof fetch;
    const saved: string[] = [];
    const save = async (write: Promise<unknown>, done: string) => { await write; saved.push(done); };
    const spec = revokeTemporaryDialog("work", "sibling", "Sibling", "api.github.com", 22, save);
    expect(spec.title).toBe("Revoke api.github.com:22?");
    expect(spec.body).toBe("Sibling in work loses access to api.github.com:22 now.");
    expect(requests).toHaveLength(0);
    await spec.onConfirm();
    expect(requests).toEqual([{ url: "/api/houses/work/temporary/api.github.com?port=22&pet=sibling", method: "DELETE" }]);
    expect(saved).toEqual(["Temporary access to api.github.com:22 revoked"]);
    await api.revokeTemporary("work", "chair", "api.github.com");
    expect(requests[1]!.url).toBe("/api/houses/work/temporary/api.github.com?port=443&pet=chair");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("reasoning effort belongs to the selected model and saved efforts survive missing metadata", () => {
  const form = renderToStaticMarkup;
  const options = { id: "opus", label: "Opus", supportedReasoningEfforts: [
    { reasoningEffort: "high", description: "More reasoning" }, { reasoningEffort: "max", description: "Maximum reasoning" },
  ], defaultReasoningEffort: "high" };
  const agent = { ...agents[0]!, modelOptions: [options] };
  const pet = { ...work.pets[0]!, reasoningEffort: "max" };
  const html = form(<HarnessFields agents={[agent]} pet={pet} />);
  expect(html).toContain("Reasoning effort");
  expect(html).toContain('value="max" selected=""');
  expect(html).toContain("Maximum reasoning");
  expect(html).toContain("Default (native)");
  const unknown = form(<HarnessFields agents={agents} pet={pet} />);
  expect(unknown).toContain('value="max" selected=""');
  expect(unknown).toContain("support unconfirmed");
  expect(unknown).not.toContain('value="xhigh"');
  expect(effortForModel("high", options)).toBe("high");
  expect(effortForModel("xhigh", options)).toBeNull();
  expect(effortForModel("high", undefined)).toBeNull();
  expect(effortForModel("high", { id: "haiku", label: "Haiku", supportedReasoningEfforts: [] })).toBeNull();
  expect(effortForModel(null, options)).toBeNull();
  const page = renderToStaticMarkup(<BotDetailPage house={{ ...work, pets: [pet] }} pet={pet} agents={[agent]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(page).toMatch(/Reasoning effort<\/span><\/div><div class="cell mono" role="cell"><span class="ellipsis">max</);
});

test("registry quick add previews exact entries and broad access before an atomic add", async () => {
  const html = renderToStaticMarkup(<AllowlistSection house={work} ask={() => {}} save={async () => {}} />);
  expect(html).toContain("Add host");
  expect(html).toContain("Add from a preset…");
  expect(html).not.toContain("Review domains"); // choosing a preset opens its review
  expect(NETWORK_PRESETS.find((preset) => preset.id === "dockerhub")?.hosts).toEqual(["registry-1.docker.io", "auth.docker.io", "production.cloudfront.docker.com"]);
  for (const preset of NETWORK_PRESETS) {
    expect(html).toContain(preset.label.replace(/&/g, "&amp;"));
    let confirmed = false;
    const spec = presetDialog("work", preset, work.allow, async () => { confirmed = true; });
    const preview = renderToStaticMarkup(<>{spec.body}{spec.children}</>);
    for (const host of preset.hosts) expect(preview).toContain(`<code>${host}</code>`);
    expect(preview).toContain("full access to these hosts, uploads included");
    expect(confirmed).toBe(false);
    await spec.onConfirm();
    expect(confirmed).toBe(true);
    expect(preset.hosts.some((host) => host.includes("*"))).toBe(false);
    if (preset.id !== "github") expect(preset.hosts.some((host) => host.includes("github"))).toBe(false);
  }
  const go = NETWORK_PRESETS.find((preset) => preset.id === "go")!;
  expect(go.note).toContain("unrelated buckets");
  const github = presetDialog("work", NETWORK_PRESETS.find((preset) => preset.id === "github")!, work.allow, async () => {});
  expect(renderToStaticMarkup(<>{github.body}{github.children}</>)).toContain("already listed");
});


test("bot environment editor separates installation from startup and offers explicit runs", () => {
  const html = renderToStaticMarkup(<BotEnvironment house="work" pet={work.pets[0]!} />);
  // Both scripts on the left, each with when it runs; Setup open in the editor first.
  expect(html).toContain("Once, when the VM is created");
  expect(html).toContain("At every boot, before the harness");
  expect(html).toContain('<span class="ellipsis">setup.sh</span>');
  expect(html).toContain("Runs once per VM, not on restarts");
  expect(html).toMatch(/<button type="button" class="btn small env-run" disabled="">.*Run now<\/button>/); // until there is a saved script
  expect(html).toContain("saving runs nothing");
  expect(html).toContain("no secrets");
  expect(html).toContain("can edit and run them too"); // the bot has tools for its own scripts
  // An empty script opens on a commented example: plainly Bash, nothing that changes the VM until edited and saved.
  for (const example of Object.values(TEMPLATES)) {
    expect(example.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    const commands = example.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
    expect(commands.every((line) => line === "set -euo pipefail" || line.startsWith("echo "))).toBe(true);
  }
  expect(TEMPLATES.setup).toContain("# sudo apt-get update");
});

test("a workspace's overview: a tile per page with what is there, its bots each a link to its page", () => {
  const html = renderToStaticMarkup(<WorkspaceOverviewPage house={work} />);
  expect(html).toContain('<h1 class="h1" tabindex="-1">work</h1>');
  expect(html).toContain('href="/workspaces/work/bots" class="stat"');
  expect(html).toContain("1 running");
  expect(html).toContain('<span class="stat-sub error">1 not open</span>'); // a channel whose token is not a bot's
  expect(html).toContain('href="/workspaces/work/bots/sibling" class="strong ellipsis row-link"');
});

test("a bot's page: its words in the text's face, its ids in mono, the mode named as in its form", () => {
  const html = renderToStaticMarkup(<BotDetailPage house={work} pet={work.pets[0]!} agents={agents} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(html).toContain(">Permission mode<");
  expect(html).toMatch(/<div class="cell" role="cell"><span>Manual<\/span><\/div>/);
  expect(html).toMatch(/<div class="cell mono" role="cell"><span class="ellipsis">opus<\/span><\/div>/);
  expect(html).not.toContain("All bots in");
  expect(html).toContain('<button type="button" class="btn danger small">Remove</button>'); // removed from its own page
});

test("a bot's Resources tab: its usage, then a stepper each up to the host's, red past 80% of it, and what all bots take", () => {
  const sized = (pet: Partial<BotView>, host = capacity.host) => renderToStaticMarkup(<BotResources house="work" pet={{ ...work.pets[0]!, ...pet }} capacity={{ ...capacity, host }} refresh={async () => {}} notify={() => {}} />);
  const standard = sized({ cpus: undefined, memoryMiB: undefined });
  expect(standard).toContain(">Usage<"); // what it uses, over what it is given
  expect(standard).toContain(">Allocation<");
  expect(standard).not.toContain('type="radio"'); // no sizes to pick: two steppers
  expect(standard).toMatch(/class="stepper"[\s\S]*value="2"[\s\S]*of 10 vCPU/); // the default, and the most there is
  expect(standard).toMatch(/value="1"[\s\S]*of 32 GiB/);
  expect(standard).toContain("Allocated: 4 of 10 vCPU · 2 of 32 GiB"); // both bots, this one at its values here
  expect(standard).not.toContain("danger");
  expect(standard).not.toContain("hint busy"); // nothing changed yet: the note stays quiet
  expect(standard).toMatch(/<button type="submit" class="btn primary" disabled="">Save</); // nothing to save yet
  // 9 of 10 vCPU for this bot alone: its stepper red with a line on why; the total, 11 of 10, red too. Still no error.
  const big = sized({ cpus: 9, memoryMiB: 3072 });
  expect(big).toMatch(/<span class="stepper danger">[\s\S]*value="9"/);
  expect(big).toMatch(/<p id="[^"]+-warning" class="hint danger">More than 80% of this host.<\/p>/);
  expect(big).toContain('<p class="hint danger" role="status">Allocated: 11 of 10 vCPU · 4 of 32 GiB — more than 80% of this host.</p>');
  expect(big).not.toContain('class="error"');
  // A host on which the saved values no longer fit (the config moved to a smaller machine): an error, not a warning.
  const small = sized({ cpus: 9, memoryMiB: 3072 }, { cpus: 4, memoryMiB: 2048 });
  expect(small).toContain("A whole number from 1 to 4.");
  expect(small).toContain("From 0.5 to 2 GiB, in steps of 0.125 GiB (128 MiB).");
  expect(small).not.toContain("Allocated:"); // nothing to add up until it fits
});

test("a harness's own settings are fields from its description: Default named, the configured value selected, an unknown one shown; harnesses without have none", () => {
  const form = (element: React.ReactElement) => renderToStaticMarkup(element);
  const tuned = { ...work.pets[0]!, agent: "tuned", model: "opus", mode: null, settings: { subagentModel: "haiku" } };
  const html = form(<HarnessFields agents={agents} pet={tuned} />);
  expect(html).toContain(">Subagent model<");
  expect(html).toContain('<option value="">Default (the bot&#x27;s own model)</option>');
  expect(html).toContain('<option value="haiku" selected="">haiku</option>');
  expect(form(<HarnessFields agents={agents} pet={{ ...tuned, settings: {} }} />)).toContain("What its subagents run on. Default: the bot&#x27;s own model.");
  expect(form(<HarnessFields agents={agents} pet={{ ...tuned, settings: { subagentModel: "gpt" } }} />)).toContain('<option value="gpt" disabled="" selected="">gpt (unknown)</option>');
  expect(form(<HarnessFields agents={agents} pet={work.pets[0]} />)).not.toContain(">Subagent model<");
});

test("a key's allowance line: what is left per window and when it resets; used up refuses, or goes on when overage is allowed", () => {
  const soon = Math.floor(Date.now() / 1000) * 1000 + 3_600_000;
  const reading = { at: Date.now(), windows: [{ name: "5h", utilization: 0.01, resetsAt: soon }, { name: "7d", utilization: 0.99, resetsAt: soon + 86_400_000 }], overage: { status: "allowed", utilization: 0 } };
  const render = (key: KeyView) => renderToStaticMarkup(<KeysSection keys={[key]} houses={["work"]} providers={["anthropic", "openai"]} refresh={async () => {}} notify={() => {}} />);
  expect(render(keys[0]!)).not.toContain("5h ");
  const fine = render({ ...keys[0]!, allowance: reading });
  expect(fine).toContain("5h 1% · 7d 99%");
  expect(fine).toContain(" · resets ");
  expect(fine).not.toContain("used up");
  const spent = render({ ...keys[0]!, allowance: { ...reading, windows: [reading.windows[0]!, { ...reading.windows[1]!, utilization: 1 }] } });
  expect(spent).toContain("7d 100% · 7d resets ");
  expect(spent).toContain("used up: requests refused until then");
  expect(spent).toContain('class="error"');
  const paid = render({ ...keys[0]!, allowOverage: true, allowance: { ...reading, windows: [reading.windows[0]!, { ...reading.windows[1]!, utilization: 1 }] } });
  expect(paid).toContain("used up, going on in overage (billed apart)");
  expect(paid).not.toContain('class="error"');
  // The dialog carries the switch.
  const edit = renderToStaticMarkup(<KeyDialog houses={["work"]} providers={["anthropic"]} keyView={{ ...keys[0]!, allowOverage: true }} onClose={() => {}} save={async () => {}} />);
  expect(edit).toContain("Go on in overage (billed apart from the subscription)");
  expect(edit).toContain("the provider bills that to credits");
});


test("Claude connectors render as a bot switch and are absent from scout settings and values", () => {
  const claude = { ...agents[0]!, settings: [...claudeCodeTmux.settings!] };
  function Form({ scope, enabled }: { scope: "bot" | "scout"; enabled: boolean }) {
    const form = useHarnessForm([claude], [], { ...work.pets[0]!, agent: claude.name, settings: enabled ? { claudeAiConnectors: "true" } : {} }, scope);
    return <>{form.fields}<output>{JSON.stringify(form.value.settings)}</output></>;
  }
  const on = renderToStaticMarkup(<Form scope="bot" enabled />);
  expect(on).toContain("Claude.ai connectors");
  expect(on).toMatch(/role="switch"[^>]* checked=""/);
  expect(renderToStaticMarkup(<Form scope="bot" enabled={false} />)).not.toMatch(/role="switch"[^>]* checked=""/);
  const scout = renderToStaticMarkup(<Form scope="scout" enabled />);
  expect(scout).not.toContain("Claude.ai connectors");
  expect(scout).not.toContain("claudeAiConnectors");
});

test("a Google account's services in words, in the catalog's order", () => {
  expect(servicesWords(["calendar", "gmail", "drive"])).toBe("Gmail, Drive and Calendar");
  expect(servicesWords(["drive", "calendar"])).toBe("Drive and Calendar");
  expect(servicesWords(["gmail"])).toBe("Gmail");
});

test("a Google account's access in words: whole, none, or the services Google let change", () => {
  expect(accessWords({ services: ["gmail", "drive"], writable: ["gmail", "drive"] })).toBe("read and write");
  expect(accessWords({ services: ["gmail", "drive"], writable: [] })).toBe("read only");
  expect(accessWords({ services: ["gmail", "drive", "calendar"], writable: ["calendar"] })).toBe("Calendar writable");
});
