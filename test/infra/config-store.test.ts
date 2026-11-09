import { expect, test } from "bun:test";
import { chmodSync, lstatSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore, NotFoundError } from "../../src/infra/config-store";
import { CONFIG_VERSION } from "../../src/infra/config-migrations";
import { ENVIRONMENT_SETUP_MAX_BYTES } from "../../src/core/environment";
import { tempDir } from "../helpers";

function store(initial?: string) {
  const path = join(tempDir(), "household.yaml");
  if (initial !== undefined) writeFileSync(path, initial);
  return { path, config: new ConfigStore(path), text: () => Bun.file(path).text() };
}

test("pet setup round-trips literal shell source in YAML, keeps comments, and clears independently", async () => {
  const { config, text } = store("# keep config\nhouses:\n  work:\n    network: {allow: []}\n    pets:\n      sibling: # keep pet\n");
  const setup = "\n  # keep indentation\ncat <<'EOF'\n  $HOME: literal # text\nEOF\nprintf 'done'  \n\n";
  await config.updatePetEnvironment("work", "sibling", { setup });
  expect((await config.load()).houses[0]!.pets[0]!.environment?.setup).toBe(setup);
  const written = await text();
  expect(written).toContain("# keep config");
  expect(written).toContain("# keep pet");
  expect(written).toMatch(/setup: \|/);
  await config.updatePet("work", "sibling", { title: "Title" });
  await config.updatePetEnvironment("work", "sibling", {});
  expect((await config.load()).houses[0]!.pets[0]!.environment?.setup).toBe(setup);
  await config.updatePetEnvironment("work", "sibling", { setup: null });
  expect((await config.load()).houses[0]!.pets[0]).toMatchObject({ title: "Title" });
  expect((await config.load()).houses[0]!.pets[0]).not.toHaveProperty("environment");
  expect(await text()).not.toContain("environment:");
  await config.updatePet("work", "sibling", { environment: { setup: "printf hi" } });
  await config.updatePetEnvironment("work", "sibling", { setup: "" });
  expect(await text()).not.toContain("environment:");
});

test("setup validates encoded size and NUL before writing, and accepts exactly the byte limit", async () => {
  const { config, text } = store();
  await config.createHouse("work");
  await config.addPet("work", "sibling", { environment: { setup: "é".repeat(ENVIRONMENT_SETUP_MAX_BYTES / 2) } });
  const before = await text();
  await expect(config.updatePetEnvironment("work", "sibling", { setup: "é".repeat(ENVIRONMENT_SETUP_MAX_BYTES / 2 + 1) })).rejects.toThrow("UTF-8 bytes at most");
  expect(await text()).toBe(before);
  await expect(config.updatePetEnvironment("work", "sibling", { setup: "echo before\0after" })).rejects.toThrow("NUL");
  expect(await text()).toBe(before);
  await expect(config.updatePetEnvironment("work", "missing", { setup: "echo hi" })).rejects.toThrow("no bot 'missing'");
});

test("hand-written setup rejects unknown environment fields and invalid source types", async () => {
  for (const environment of ["{setup: 12}", "{setup: true}", "{commands: echo}"]) {
    await expect(store(`houses:\n  work:\n    network: {allow: []}\n    pets:\n      sibling:\n        environment: ${environment}\n`).config.load()).rejects.toThrow("invalid config");
  }
});

test("missing file is an empty household; a new house starts with an empty allowlist", async () => {
  const { config, text } = store();
  expect(await config.load()).toEqual({ daemon: {}, keys: [], houses: [] });
  await config.createHouse("work");
  await config.addPet("work", "sibling");
  expect(await config.load()).toEqual({
    daemon: {},
    keys: [],
    houses: [
      {
        name: "work",
        resources: { cpus: 8, memoryMiB: 8192 },
        network: { kind: "allowlist", allow: [] },
        pets: [{ name: "sibling" }],
        people: { owners: [] },
        channels: [],
      },
    ],
  });
  expect(await text()).toBe(
    `version: ${CONFIG_VERSION}\n` + // a new config is written at the latest version
    "houses:\n  work:\n    resources:\n      cpus: 8\n      memoryMiB: 8192\n    network:\n      allow: []\n    pets:\n      sibling: {}\n",
  );
});

test("domain errors surface and leave the file untouched", async () => {
  const { config, text } = store();
  await config.createHouse("work");
  const before = await text();
  await expect(config.addPet("home", "sibling")).rejects.toThrow("unknown workspace 'home'");
  expect(await text()).toBe(before);
});

test("valueless keys (YAML null) read as empty and can be edited", async () => {
  const empty = store("houses:\n");
  expect(await empty.config.load()).toEqual({ daemon: {}, keys: [], houses: [] });
  await empty.config.createHouse("work");
  expect(await empty.text()).toBe("houses:\n  work:\n    resources:\n      cpus: 8\n      memoryMiB: 8192\n    network:\n      allow: []\n");

  const { config, text } = store("houses:\n  work:\n    network:\n      allow:\n    pets:\n");
  expect(await config.load()).toEqual({
    daemon: {},
    keys: [],
    houses: [{ name: "work", network: { kind: "allowlist", allow: [] }, pets: [], people: { owners: [] }, channels: [] }],
  });
  await config.addPet("work", "sibling");
  expect(await text()).toBe("houses:\n  work:\n    network:\n      allow:\n    pets:\n      sibling: {}\n");
});

test("CLI edits keep hand-written comments, ordering and formatting", async () => {
  const handWritten = `# Oleg's household
houses:
  # the rich house
  work:
    network:
      allow: [api.anthropic.com, github.com, "db.internal:5432"] # keep me
    pets:
      sibling: # first pet
`;
  const { config, text } = store(handWritten);
  await config.addPet("work", "chair");
  await config.createHouse("home");
  const after = await text();
  expect(after).toStartWith("# Oleg's household\nhouses:\n  # the rich house\n  work:\n");
  expect(after).toContain("# keep me");
  expect(after).toContain("sibling: # first pet");
  expect(after.indexOf("chair")).toBeGreaterThan(after.indexOf("sibling"));
  expect(after.indexOf("home:")).toBeGreaterThan(after.indexOf("chair"));
  const household = await config.load();
  expect(household.houses.map((h) => [h.name, h.pets.map((pet) => pet.name)])).toEqual([
    ["work", ["sibling", "chair"]],
    ["home", []],
  ]);
  expect(household.houses[0]!.network.allow).toContainEqual({ host: "db.internal", port: 5432 });
});

test("a pet may name its agent; otherwise the app's default applies", async () => {
  const { config } = store("houses:\n  work:\n    network: {allow: []}\n    pets:\n      a:\n      b: {}\n      c: {agent: codex}\n");
  expect((await config.load()).houses[0]!.pets).toEqual([
    { name: "a" },
    { name: "b" },
    { name: "c", agent: "codex" },
  ]);
});

test("the daemon section is optional and validated", async () => {
  expect((await store("daemon:\n  agentPort: 7400\n").config.load()).daemon).toEqual({ agentPort: 7400 });
  await expect(store("daemon:\n  agentPort: 70000\n").config.load()).rejects.toThrow("invalid config");
});

test("invalid hand edits are reported with their location", async () => {
  await expect(store("houses:\n  work:\n    netwrok: {}\n").config.load()).rejects.toThrow(/invalid config .*household\.yaml/);
  await expect(store("houses:\n  Work:\n    network: {allow: []}\n").config.load()).rejects.toThrow("at houses.Work");
  await expect(store("houses:\n  work:\n    network: {allow: ['a b']}\n").config.load()).rejects.toThrow(
    "'a b' is not host or host:port",
  );
  await expect(store("houses: [\n").config.load()).rejects.toThrow("invalid YAML");
});

test("a pet's title and aliases, the house's channels and owners are set from the CLI and read into the model", async () => {
  const { config, text } = store();
  await config.createHouse("work");
  await config.addPet("work", "sibling", { title: "Sibling" });
  await config.addOwner("work", "telegram", "100200300");
  await config.addOwner("work", "telegram", " 100200300 "); // the same: nothing changes
  await config.addChannel("work", { kind: "telegram-private", token: "4242:work-bot-token", chat: "100200300", pets: ["sibling"], name: "DM" });
  expect(await text()).toBe(
    `version: ${CONFIG_VERSION}\n` + // a new config is written at the latest version
    "houses:\n  work:\n    resources:\n      cpus: 8\n      memoryMiB: 8192\n    network:\n      allow: []\n    pets:\n      sibling:\n        title: Sibling\n    people:\n      owners:\n        telegram:\n          - 100200300\n" +
      "    channels:\n      - kind: telegram-private\n        name: DM\n        token: 4242:work-bot-token\n        chat: 100200300\n        pets:\n          - sibling\n",
  );
  const [house] = (await config.load()).houses;
  expect(house!.pets).toEqual([{ name: "sibling", title: "Sibling" }]);
  expect(house!.people).toEqual({ owners: [{ platform: "telegram", id: "100200300" }] });
  expect(house!.channels).toEqual([{ kind: "telegram-private", name: "DM", token: "4242:work-bot-token", chat: "100200300", pets: ["sibling"] }]);
  await config.addChannel("work", { kind: "telegram-private", token: "4242:work-bot-token", chat: "42" }); // no pets yet
  expect((await config.load()).houses[0]!.channels.map((channel) => channel.chat)).toEqual(["100200300", "42"]);
  expect((await config.removeChannel("work", "100200300")).removed).toMatchObject({ name: "DM" }); // by its chat
  expect((await config.removeChannel("work", " 42 ")).removed).toMatchObject({ chat: "42" });
  await expect(config.removeChannel("work", "42")).rejects.toThrow("workspace 'work' has no channel of chat '42' (its chats: none)");
  await config.removeOwner("work", "telegram", "100200300");
  expect((await config.load()).houses[0]).toMatchObject({ people: { owners: [] }, channels: [] });
  await expect(config.addChannel("home", { kind: "telegram-private", token: "x", chat: "1" })).rejects.toThrow("unknown workspace 'home'");
});

test("channels are checked at load: pets of the house, a default with two pets or more, no alias two pets answer to", async () => {
  const yaml = (channel: string, pets = "sibling:\n      diet: {title: Chef, aliases: [Šéf]}") =>
    `houses:\n  work:\n    network: {allow: []}\n    people: {owners: {telegram: [1]}}\n    pets:\n      ${pets}\n    channels:\n      - {kind: telegram-private, token: b, chat: 1, ${channel}}\n`;
  const [house] = (await store(yaml("pets: [sibling, diet], default: diet")).config.load()).houses;
  expect(house!.channels[0]).toEqual({ kind: "telegram-private", token: "b", chat: "1", pets: ["sibling", "diet"], default: "diet" });
  expect(house!.pets[1]).toEqual({ name: "diet", title: "Chef", aliases: ["Šéf"] });
  await expect(store(yaml("pets: [sibling, diet]")).config.load()).rejects.toThrow("default is required when a channel has two bots or more");
  await expect(store(yaml("pets: [ghost]")).config.load()).rejects.toThrow("'ghost' is not a bot of workspace work");
  await expect(store(yaml("pets: [sibling, diet], default: diet", "sibling: {aliases: [šéf]}\n      diet: {aliases: [Šéf]}")).config.load()).rejects.toThrow(
    "bots sibling and diet both answer to 'Šéf'",
  );
  await expect(store(yaml("pets: [sibling]", "sibling: {aliases: ['a, b']}")).config.load()).rejects.toThrow("an alias has no , : or line break");
  await expect(store(yaml("pets: []").replace("chat: 1", "chat: -100")).config.load()).rejects.toThrow("must be a Telegram chat id");
  await expect(store(yaml("pets: []").replace("telegram-private", "whatsapp")).config.load()).rejects.toThrow("invalid config");
});

test("a pet's emoji: one emoji is written and read; anything else is a config error; null removes it", async () => {
  const { config, text } = store();
  const pets = async () => (await config.load()).houses[0]!.pets;
  await config.createHouse("work");
  await config.addPet("work", "sibling", { emoji: "🦉" });
  expect(await text()).toContain("sibling:\n        emoji: 🦉\n");
  expect(await pets()).toEqual([{ name: "sibling", emoji: "🦉" }]);
  for (const bad of ["owl", "🦉🦉", "7"]) await expect(config.updatePet("work", "sibling", { emoji: bad })).rejects.toThrow("must be one emoji");
  await config.updatePet("work", "sibling", { emoji: "👩‍💻" });
  expect((await pets())[0]!.emoji).toBe("👩‍💻");
  await config.updatePet("work", "sibling", { emoji: "❤\u{200D}🔥" }); // written fully qualified
  expect(await text()).toContain("emoji: ❤\u{FE0F}\u{200D}🔥\n");
  await config.updatePet("work", "sibling", { emoji: "#\u{20E3}", title: "  Sibling  " });
  expect(await text()).toContain('emoji: "#\u{FE0F}\u{20E3}"'); // quoted: a bare # would start a comment
  expect((await pets())[0]).toEqual({ name: "sibling", title: "Sibling", emoji: "#\u{FE0F}\u{20E3}" });
  await config.updatePet("work", "sibling", { emoji: " ", title: " " }); // only spaces: the settings go
  expect(await pets()).toEqual([{ name: "sibling" }]);
});

test("a pet's emoji read from YAML: fully qualified; unquoted # (null) says to quote it", async () => {
  const yaml = (emoji: string) => `houses:\n  work:\n    network:\n      allow: []\n    pets:\n      sibling:\n        emoji: ${emoji}\n`;
  expect((await store(yaml("❤")).config.load()).houses[0]!.pets[0]!.emoji).toBe("❤\u{FE0F}");
  await expect(store(yaml("#️⃣")).config.load()).rejects.toThrow('emoji is empty; quote it in YAML, e.g. emoji: "#️⃣"');
  await expect(store(yaml("©")).config.load()).rejects.toThrow("must be one emoji");
  expect((await store(yaml('"#️⃣"')).config.load()).houses[0]!.pets[0]!.emoji).toBe("#️⃣");
});

test("owners by platform: `owners: {telegram: [ids]}`; the old shapes say what to write instead; ids too large for YAML must be quoted", async () => {
  const yaml = (owners: string) => `houses:\n  work:\n    network: {allow: []}\n    people:\n      owners:${owners}`;
  const owners = async (text: string) => (await store(yaml(text)).config.load()).houses[0]!.people.owners;
  expect(await owners("\n        telegram: [100200300, \"42\"]\n")).toEqual([{ platform: "telegram", id: "100200300" }, { platform: "telegram", id: "42" }]);
  expect(await owners(" {telegram: }\n")).toEqual([]);
  const replacement = "owners are listed by platform now; write:\n  owners:\n    telegram:\n      - 100200300\n      - 42";
  await expect(owners("\n        - 100200300\n        - telegram: 42\n")).rejects.toThrow(replacement); // a bare id (before platforms), or a pair (7040098)
  await expect(owners("\n        - 12345678901234567890\n")).rejects.toThrow('- "<the id, quoted>"'); // never a rounded number
  await expect(owners(" {Telegram: [1]}\n")).rejects.toThrow("unknown platform 'Telegram' (known: telegram, slack)");
  await expect(owners(" {telegram: [12345678901234567890]}\n")).rejects.toThrow("too large for a YAML number: quote it");
  expect(await owners(' {telegram: ["12345678901234567890"]}\n')).toEqual([{ platform: "telegram", id: "12345678901234567890" }]); // quoted: kept (the app's check refuses it)
  await expect(owners(" {telegram: ['']}\n")).rejects.toThrow("an owner id is a number or a string");
  const chat = `houses:\n  work:\n    network: {allow: []}\n    channels:\n      - {kind: telegram-private, token: b, chat: 12345678901234567890}\n`;
  await expect(store(chat).config.load()).rejects.toThrow("too large for a YAML number: quote it");
});

test("an owner is a bare id or {id, note}; a note is one line of 200 characters at most; a channel may have one too", async () => {
  const yaml = (owners: string, channel = "") =>
    `houses:\n  work:\n    network: {allow: []}\n    people:\n      owners: ${owners}\n${channel ? `    channels:\n      - {kind: telegram-private, token: b, chat: 1, ${channel}}\n` : ""}`;
  const house = async (text: string) => (await store(text).config.load()).houses[0]!;
  expect((await house(yaml('{telegram: [100200300, {id: 777, note: " Vera "}]}'))).people.owners).toEqual([
    { platform: "telegram", id: "100200300" },
    { platform: "telegram", id: "777", note: "Vera" },
  ]);
  expect((await house(yaml("{telegram: [1]}", "note: test bot"))).channels[0]!.note).toBe("test bot");
  for (const [owners, error] of [
    ["{telegram: [{id: 7, name: x}]}", "an owner is an id, or {id, note}"],
    [`{telegram: [{id: 7, note: ${"x".repeat(201)}}]}`, "a note is 200 characters at most"],
    ['{telegram: [{id: 7, note: "a\\nb"}]}', "a note is plain text on one line"],
    ["{telegram: [{note: x}]}", "an owner is an id, or {id, note}"],
  ]) await expect(store(yaml(owners!)).config.load()).rejects.toThrow(error!);
});

test("an owner's note is added, changed and removed in place (comments kept); removing works by id whatever the shape", async () => {
  const { config, text } = store("houses:\n  work:\n    network: {allow: []}\n    people:\n      owners:\n        telegram:\n          - 777 # Vera's\n");
  await config.addOwner("work", "telegram", "100200300", " my phone ");
  expect(await text()).toContain("- id: 100200300\n            note: my phone");
  await config.updateOwner("work", "telegram", "777", "Vera");
  expect(await text()).toContain("# Vera's");
  expect((await config.load()).houses[0]!.people.owners).toEqual([
    { platform: "telegram", id: "777", note: "Vera" },
    { platform: "telegram", id: "100200300", note: "my phone" },
  ]);
  await config.updateOwner("work", "telegram", "100200300", null); // a bare id again
  expect((await config.load()).houses[0]!.people.owners[1]).toEqual({ platform: "telegram", id: "100200300" });
  await config.removeOwner("work", "telegram", "777"); // an {id, note} item
  expect((await config.load()).houses[0]!.people.owners).toEqual([{ platform: "telegram", id: "100200300" }]);
  await expect(config.updateOwner("work", "telegram", "1", "x")).rejects.toThrow("workspace 'work' has no owner telegram 1");
});

test("owners are added to and removed from their platform's list, the ids read as the schema reads them", async () => {
  const { config, text } = store("houses:\n  work:\n    network: {allow: []}\n    people:\n      owners:\n        telegram:\n          - \"777\" # quoted\n");
  await config.addOwner("work", "telegram", "100200300");
  expect(await text()).toContain('- "777" # quoted\n          - 100200300');
  await config.removeOwner("work", "telegram", " 777 ");
  expect((await config.load()).houses[0]!.people.owners).toEqual([{ platform: "telegram", id: "100200300" }]);
  await expect(config.addOwner("work", "whatsapp", "1")).rejects.toThrow("unknown platform 'whatsapp' (known: telegram, slack)");
});

test("an edit that would break the config is refused and not written", async () => {
  const { config, text } = store();
  await config.createHouse("work");
  await config.createHouse("home");
  await config.addPet("work", "sibling");
  await config.addOwner("home", "telegram", "1");
  const before = await text();
  await expect(config.addChannel("home", { kind: "telegram-private", token: "a b", chat: "1" })).rejects.toThrow("houses.home.channels[0].token");
  await expect(config.addChannel("home", { kind: "whatsapp", token: "b", chat: "1" })).rejects.toThrow("houses.home.channels[0].kind");
  await expect(config.addChannel("work", { kind: "telegram-private", token: "b", chat: "x1" })).rejects.toThrow("invalid config");
  await expect(config.addChannel("work", { kind: "telegram-private", token: "b", chat: "1", pets: ["ghost"] })).rejects.toThrow("'ghost' is not a bot of workspace work");
  await expect(config.addOwner("work", "telegram", " ")).rejects.toThrow("is not a person's id");
  await expect(config.addPet("work", "chair", { title: "x".repeat(65) })).rejects.toThrow("invalid config");
  expect(await text()).toBe(before);
});

test("the web UI's edits: hosts added at the end and removed one at a time, other entries keep their comments; a house goes", async () => {
  const { config, text } = store(`houses:
  work:
    network:
      allow:
        - github.com # code
        - db.internal:5432 # the database
  home: # keep this house
    network: {allow: []}
`);
  const added = await config.allowHost("work", " PyPI.org ");
  expect(added.household.houses[0]!.network.allow).toContainEqual({ host: "pypi.org", port: 443 }); // what it wrote
  expect(added).toMatchObject({ entry: "pypi.org", changed: true });
  expect(await config.allowHost("work", "pypi.org:443")).toMatchObject({ entry: "pypi.org", changed: false }); // the same endpoint: nothing changes
  expect(await config.disallowHost("work", "GitHub.com:443")).toMatchObject({ entry: "github.com", changed: true });
  expect(await config.disallowHost("work", "github.com")).toMatchObject({ entry: "github.com", changed: false }); // gone already: nothing changes
  expect(await text()).toContain("        - db.internal:5432 # the database\n        - pypi.org\n");
  expect(await text()).not.toContain("github.com");
  await config.allowHost("home", "example.com");
  expect(await text()).toContain("network: { allow: [ example.com ] }");

  expect((await config.deleteHouse("work")).houses.map((house) => house.name)).toEqual(["home"]);
  expect(await text()).toContain("# keep this house"); // the yaml library may move it below its key
});

test("a wildcard entry: written quoted, read back, kept with its comment, one per entry and port", async () => {
  const { config, text } = store(`houses:
  work:
    network:
      allow:
        - "*.github.com" # its subdomains
        - github.com
`);
  expect((await config.load()).houses[0]!.network.allow).toEqual([{ host: "*.github.com", port: 443 }, { host: "github.com", port: 443 }]);
  await config.allowHost("work", "*.GitHub.com:443"); // the same entry: nothing changes
  await config.allowHost("work", "*.example.com:8443");
  expect(await text()).toContain('        - "*.github.com" # its subdomains\n        - github.com\n        - "*.example.com:8443"\n');
  await config.disallowHost("work", "*.github.com");
  expect(await text()).not.toContain("*.github.com");
  expect(await text()).toContain("        - github.com\n"); // the apex is its own entry
  for (const bad of ["*.com", "api.*.com", "*foo.com", "*.0.1", "host:*"]) await expect(config.allowHost("work", bad)).rejects.toThrow(`'${bad}' is not host or host:port`);
  await expect(config.allowHost("work", "münchen.de")).rejects.toThrow("a non-ASCII host is written in punycode (xn--…)");
  for (const unquoted of ["[*.example.com]", "[*:*]", "[*:8080]", "\n        - *\n"]) {
    await expect(store(`houses:\n  work:\n    network:\n      allow: ${unquoted}\n`).config.load()).rejects.toThrow('a wildcard host is quoted: "*.example.com", "*"');
  }
  // A real alias is no wildcard: no hint.
  const alias = store("houses:\n  work:\n    network: {allow: [*github]}\n").config.load();
  await expect(alias).rejects.toThrow("Unresolved alias");
  await expect(alias).rejects.not.toThrow("a wildcard host is quoted");
});

test("the whole internet: written quoted in one spelling, removed in any", async () => {
  const { config, text } = store("houses:\n  work:\n    network:\n      allow: []\n");
  expect(await config.allowHost("work", " *:443 ")).toMatchObject({ entry: "*", changed: true });
  expect(await config.allowHost("work", "*:*")).toMatchObject({ entry: "*:*", changed: true });
  expect(await config.allowHost("work", "*:8080")).toMatchObject({ entry: "*:8080", changed: true });
  expect(await text()).toContain('allow: [ "*", "*:*", "*:8080" ]');
  expect((await config.load()).houses[0]!.network.allow).toEqual([{ host: "*", port: 443 }, { host: "*", port: "*" }, { host: "*", port: 8080 }]);
  expect(await config.disallowHost("work", "*:443")).toMatchObject({ entry: "*", changed: true });
  expect(await config.disallowHost("work", "*")).toMatchObject({ changed: false });
  expect(await text()).toContain('allow: [ "*:*", "*:8080" ]');
});

test("disallow removes an entry an alias stands for", async () => {
  // The anchor sits on an entry of another house.
  const { config, text } = store("houses:\n  home:\n    network:\n      allow: [&gh github.com]\n  work:\n    network:\n      allow: [*gh, pypi.org]\n");
  expect(await config.disallowHost("work", "github.com")).toMatchObject({ changed: true });
  expect(await text()).toContain("allow: [ pypi.org ]");
});

test("the web UI's edits are checked before anything is written", async () => {
  const { config, text } = store();
  await config.createHouse("work");
  const before = await text();
  await expect(config.allowHost("work", "a b")).rejects.toThrow("'a b' is not host or host:port");
  await expect(config.disallowHost("work", "a b")).rejects.toThrow("'a b' is not host or host:port");
  await expect(config.allowHost("home", "example.com")).rejects.toThrow(NotFoundError);
  await expect(config.deleteHouse("home")).rejects.toThrow("unknown workspace 'home'");
  expect(await text()).toBe(before);
});

test("concurrent edits by two editors (each its own store, as the CLI and the daemon) lose nothing", async () => {
  const { path, config } = store("# shared\n");
  const other = new ConfigStore(path);
  const names = Array.from({ length: 12 }, (_, i) => `house-${i}`);
  await Promise.all(names.map((name, i) => (i % 2 ? config : other).createHouse(name)));
  expect((await config.load()).houses.map((house) => house.name).sort()).toEqual([...names].sort());
});

test("pets and channels are changed and removed in place: comments kept; a removed pet leaves every channel", async () => {
  const { config, text } = store(`houses:
  work:
    network: {allow: []}
    people: {owners: {telegram: [1]}}
    pets:
      sibling: # the first
      diet:
        title: Chef # shown in the chat
    channels:
      - kind: telegram-private # my DM
        token: b
        chat: 1
        pets: [sibling, diet]
        default: diet
`);
  await config.updatePet("work", "sibling", { title: "Sibling", aliases: ["Sib"], model: "sonnet", mode: "manual" });
  await config.updatePet("work", "diet", { title: null });
  await config.updateChannel("work", "1", { name: "DM", token: "b2" });
  let house = (await config.load()).houses[0]!;
  expect(house.pets).toEqual([{ name: "sibling", title: "Sibling", aliases: ["Sib"], model: "sonnet", mode: "manual" }, { name: "diet" }]);
  expect(house.channels[0]).toEqual({ kind: "telegram-private", name: "DM", token: "b2", chat: "1", pets: ["sibling", "diet"], default: "diet" });
  await config.removePet("work", "diet"); // the default, with one pet left: sibling is it now
  house = (await config.load()).houses[0]!;
  expect(house.pets.map((pet) => pet.name)).toEqual(["sibling"]);
  expect(house.channels[0]).toMatchObject({ pets: ["sibling"] });
  expect(house.channels[0]!.default).toBeUndefined();
  const yaml = await text();
  expect(yaml).toContain("# the first");
  expect(yaml).toContain("# my DM");
  await expect(config.updatePet("work", "ghost", {})).rejects.toThrow(NotFoundError);
  await expect(config.updateChannel("work", "9", {})).rejects.toThrow("workspace 'work' has no channel of chat '9'");
});

test("a check beyond the schema (the app's agents) refuses an edit that adds a problem; one typed in by hand still loads and can be fixed", async () => {
  const path = join(tempDir(), "household.yaml");
  writeFileSync(path, "houses:\n  work:\n    network: {allow: []}\n    pets:\n      sibling: {model: big}\n");
  const config = new ConfigStore(path, (household) =>
    household.houses.flatMap((house) => house.pets.filter((pet) => pet.model === "big").map((pet) => `bot ${pet.name}: no model 'big'`)),
  );
  expect((await config.load()).houses[0]!.pets[0]!.model).toBe("big"); // loads: the web UI shows it, marked
  await config.allowHost("work", "example.com"); // other edits go on
  await expect(config.addPet("work", "chair", { model: "big" })).rejects.toThrow("bot chair: no model 'big'");
  expect(await Bun.file(path).text()).not.toContain("chair");
  await config.updatePet("work", "sibling", { model: "small" }); // an edit may fix it
  expect((await config.load()).houses[0]!.pets[0]!.model).toBe("small");
});

test("the config is written whole, through a symlink, always mode 600 (it holds keys and tokens); a load never sees an edit half done", async () => {
  const dir = tempDir();
  const real = join(dir, "real.yaml");
  writeFileSync(real, "houses:\n", { mode: 0o640 });
  chmodSync(real, 0o640);
  const link = join(dir, "household.yaml");
  symlinkSync(real, link);
  const config = new ConfigStore(link);
  await config.createHouse("work");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(real, "utf8")).toContain("work:");
  expect(statSync(real).mode & 0o777).toBe(0o600); // a 640 by hand is 600 after the first edit
  expect(readdirSync(dir).sort()).toEqual(["household.yaml", "real.yaml"]); // no temp file left
  const fresh = join(tempDir(), "household.yaml");
  await new ConfigStore(fresh).createHouse("work");
  expect(statSync(fresh).mode & 0o777).toBe(0o600);
  // Loads while edits run: each sees a whole config, before or after an edit.
  const names = Array.from({ length: 8 }, (_, i) => `house-${i}`);
  const loads: Promise<unknown>[] = [];
  await Promise.all(names.map(async (name) => {
    loads.push(config.load());
    await config.createHouse(name);
  }));
  await Promise.all(loads); // none threw (a half file would)
  expect((await config.load()).houses).toHaveLength(9);
});

test("a list edited item by item: what stays keeps its comment; no aliases is no aliases key; no pets is pets: []", async () => {
  const { config, text } = store(`houses:
  work:
    network: {allow: []}
    people: {owners: {telegram: [1]}}
    pets:
      sibling: {aliases: [Sib]}
      diet:
      chair:
    channels:
      - kind: telegram-private
        token: b
        chat: 1
        pets:
          - sibling # the first
          - diet # to go
        default: sibling
`);
  await config.updateChannel("work", "1", { pets: ["sibling", "chair"] });
  expect(await text()).toContain("          - sibling # the first\n          - chair\n");
  await config.updatePet("work", "sibling", { aliases: [] });
  expect(await text()).toContain("      sibling: {}\n");
  await config.updateChannel("work", "1", { pets: [], default: null });
  expect((await config.load()).houses[0]!.channels[0]!.pets).toEqual([]);
  await config.addChannel("work", { kind: "telegram-private", token: "b", chat: "2", name: "", pets: ["diet"] });
  expect(await text()).toContain("      - kind: telegram-private\n        token: b\n        chat: 2\n        pets:\n          - diet\n");
});

test("keys: added on top (before the houses), changed, removed; one a pet names cannot go; a pet names its key", async () => {
  const { config, text } = store("# my household\nhouses:\n  work:\n    network: {allow: []}\n    pets:\n      sibling:\n");
  await config.addKey("claude", { provider: "anthropic", value: " sk-ant-oat01-one ", note: "Max" });
  await config.addKey("api", { provider: "anthropic", value: "sk-ant-api03-two" });
  expect(await text()).toStartWith("# my household\nkeys:\n  claude:\n    provider: anthropic\n    value: sk-ant-oat01-one\n    note: Max\n  api:\n");
  await expect(config.addKey("claude", { provider: "anthropic", value: "x" })).rejects.toThrow("key 'claude' already exists");
  await expect(config.addKey("gpt", { provider: "mistral", value: "x" })).rejects.toThrow("unknown provider 'mistral' (known: anthropic, openai)");
  await expect(config.addKey("Bad Name", { provider: "anthropic", value: "x" })).rejects.toThrow("invalid key name");
  await expect(config.addKey("spaced", { provider: "anthropic", value: "a b" })).rejects.toThrow("a key's value is printable ASCII without spaces");
  await config.updateKey("claude", { value: "sk-ant-oat01-rotated", note: null });
  await config.updatePet("work", "sibling", { key: "claude" });
  const household = await config.load();
  expect(household.keys).toEqual([
    { name: "claude", provider: "anthropic", value: "sk-ant-oat01-rotated" },
    { name: "api", provider: "anthropic", value: "sk-ant-api03-two" },
  ]);
  expect(household.houses[0]!.pets).toEqual([{ name: "sibling", key: "claude" }]);
  await expect(config.removeKey("claude")).rejects.toThrow("key 'claude' is in use by work/sibling: give it another key first");
  await config.removeKey("api");
  await expect(config.removeKey("api")).rejects.toThrow(NotFoundError);
  await config.updatePet("work", "sibling", { key: null }); // the store has no check here; the app's says it needs one
  expect((await config.load()).houses[0]!.pets).toEqual([{ name: "sibling" }]);
});

test("a YAML error never quotes the file", async () => {
  const broken = "keys:\n  claude: {provider: anthropic, value: sk-ant-oat01-SECRET-VALUE: x: y}\n";
  const error = await store(broken).config.load().catch((caught: Error) => caught.message);
  expect(error).toContain("invalid YAML");
  expect(error).not.toContain("SECRET-VALUE");
});

test("a note of nothing is no note; a control or direction character is refused; a bare owner is a list of one", async () => {
  const yaml = (owners: string, channelNote = "") =>
    `houses:\n  work:\n    network: {allow: []}\n    people:\n      owners: ${owners}\n    channels:\n      - {kind: telegram-private, token: b, chat: 1${channelNote}}\n`;
  const house = async (text: string) => (await store(text).config.load()).houses[0]!;
  const read = await house(yaml('{telegram: [{id: 7, note: ""}, {id: 8, note: }]}', ", note: ''"));
  expect(read.people.owners).toEqual([{ platform: "telegram", id: "7" }, { platform: "telegram", id: "8" }]);
  expect(read.channels[0]!.note).toBeUndefined();
  for (const bad of ["a\\u0007b", "a\\u202Eb", "a\\u2028b", "a\\u2066b"]) {
    await expect(store(yaml(`{telegram: [{id: 7, note: "${bad}"}]}`)).config.load()).rejects.toThrow("a note is plain text on one line");
  }
  expect((await house(yaml('{telegram: [{id: 7, note: "a\\tb"}]}'))).people.owners[0]!.note).toBe("a\tb"); // a tab is fine
  expect((await house(yaml("{telegram: 777}"))).people.owners).toEqual([{ platform: "telegram", id: "777" }]);
});

test("owners: one there already takes the note given; a note set on {id, note} keeps its comments; a bare owner is edited as a list", async () => {
  const { config, text } = store("houses:\n  work:\n    network: {allow: []}\n    people:\n      owners:\n        telegram:\n          - id: 777 # Vera's id\n            note: old\n          - 100200300\n");
  await config.addOwner("work", "telegram", "100200300", "my phone"); // there already: its note is set, in place
  await config.updateOwner("work", "telegram", "777", "Vera");
  expect(await text()).toContain("- id: 777 # Vera's id\n            note: Vera\n          - id: 100200300\n            note: my phone\n");
  await config.updateOwner("work", "telegram", "777", null);
  expect(await text()).toContain("- id: 777 # Vera's id\n          - id: 100200300");
  const bare = store("houses:\n  work:\n    network: {allow: []}\n    people:\n      owners:\n        telegram: 777 # the only one\n");
  await bare.config.addOwner("work", "telegram", "42");
  expect((await bare.config.load()).houses[0]!.people.owners.map((owner) => owner.id)).toEqual(["777", "42"]);
  await bare.config.removeOwner("work", "telegram", "777");
  await bare.config.updateOwner("work", "telegram", "42", "x");
  expect((await bare.config.load()).houses[0]!.people.owners).toEqual([{ platform: "telegram", id: "42", note: "x" }]);
});

test("a channel edit can change the house's other channels in the same write (its bot's new token)", async () => {
  const { config } = store("houses:\n  work:\n    network: {allow: []}\n    channels:\n      - {kind: telegram-private, token: 1:old, chat: 1}\n      - {kind: telegram-private, token: 1:old, chat: 2}\n");
  await config.updateChannel("work", "1", { token: "1:new" }, [{ chat: "2", fields: { token: "1:new" } }]);
  expect((await config.load()).houses[0]!.channels.map((channel) => channel.token)).toEqual(["1:new", "1:new"]);
  await config.addChannel("work", { kind: "telegram-private", token: "1:newer", chat: "3" }, [{ chat: "1", fields: { token: "1:newer" } }, { chat: "2", fields: { token: "1:newer" } }]);
  expect((await config.load()).houses[0]!.channels.map((channel) => channel.token)).toEqual(["1:newer", "1:newer", "1:newer"]);
});


test("explicit reasoning effort persists through add, edits, reload and clearing", async () => {
  const { config, text } = store();
  await config.createHouse("work");
  await config.addPet("work", "sibling", { reasoningEffort: "high" });
  expect((await config.load()).houses[0]!.pets[0]!.reasoningEffort).toBe("high");
  expect(await text()).toContain("reasoningEffort: high");
  await config.updatePet("work", "sibling", { title: "Sibling" });
  expect((await config.load()).houses[0]!.pets[0]!.reasoningEffort).toBe("high");
  await config.updatePet("work", "sibling", { reasoningEffort: "low" });
  expect((await config.load()).houses[0]!.pets[0]!.reasoningEffort).toBe("low");
  await config.updatePet("work", "sibling", { reasoningEffort: null });
  expect((await config.load()).houses[0]!.pets[0]!.reasoningEffort).toBeUndefined();
  expect(await text()).not.toContain("reasoningEffort");
  await config.updatePet("work", "sibling", { reasoningEffort: "high" });
  await config.updatePet("work", "sibling", { reasoningEffort: "" });
  expect(await text()).not.toContain("reasoningEffort");
});

test("bulk allowlist additions validate atomically, deduplicate normalized endpoints and preserve other edits", async () => {
  const { config, text, path } = store("houses:\n  work:\n    network:\n      allow:\n        - github.com # keep this\n");
  const before = await text();
  await expect(config.allowHosts("work", ["pypi.org", "bad host"])).rejects.toThrow();
  expect(await text()).toBe(before);
  const result = await config.allowHosts("work", ["GitHub.com:443", "PyPI.org", "pypi.org:443", "files.pythonhosted.org"]);
  expect(result.added).toEqual(["pypi.org", "files.pythonhosted.org"]);
  expect(await text()).toContain("github.com # keep this");
  expect((await config.allowHosts("work", ["pypi.org"])).added).toEqual([]);
  const other = new ConfigStore(path);
  await Promise.all([config.allowHosts("work", ["index.crates.io", "static.crates.io"]), other.allowHost("work", "example.org")]);
  expect((await config.load()).houses[0]!.network.allow.map((entry) => entry.host).sort()).toEqual(["github.com", "pypi.org", "files.pythonhosted.org", "index.crates.io", "static.crates.io", "example.org"].sort());
  await config.disallowHost("work", "index.crates.io");
  expect((await config.load()).houses[0]!.network.allow.some((entry) => entry.host === "static.crates.io")).toBe(true);
});


test("pet identifiers allow underscores through config edits, channel references and reload; other identifiers keep their alphabet", async () => {
  const { config, text } = store();
  await config.createHouse("work");
  const title = "Φίλος 朋友 & café — 👩‍💻";
  await config.addPet("work", "my_pet-2", { title });
  await config.addChannel("work", { kind: "telegram-private", token: "token", chat: "1", pets: ["my_pet-2"], default: "my_pet-2" });
  const house = (await config.load()).houses[0]!;
  expect(house.pets).toEqual([{ name: "my_pet-2", title }]);
  expect(house.channels[0]).toMatchObject({ pets: ["my_pet-2"], default: "my_pet-2" });
  const before = await text();
  await expect(config.createHouse("my_house")).rejects.toThrow("invalid workspace name");
  await expect(config.addKey("my_key", { provider: "anthropic", value: "key" })).rejects.toThrow("invalid key name");
  await expect(config.updatePet("work", "my_pet-2", { agent: "my_agent" })).rejects.toThrow("invalid config");
  for (const title of ["first\nsecond", "hello\0world", "hello\u202Eworld", "x".repeat(65)]) {
    await expect(config.updatePet("work", "my_pet-2", { title })).rejects.toThrow("invalid config");
  }
  expect(await text()).toBe(before);
  await config.removePet("work", "my_pet-2");
  expect((await config.load()).houses[0]!.channels[0]).toMatchObject({ pets: [] });
});

test("a grant approved from chat is kept apart from the owner's allowlist: public addresses only, until the owner lists it", async () => {
  const { config, text } = store(`houses:
  work:
    network:
      allow:
        - github.com # code
`);
  expect(await config.grantHost("work", "API.example.org:8443")).toMatchObject({ entry: "api.example.org:8443", changed: true });
  expect(await config.grantHost("work", "api.example.org:8443")).toMatchObject({ changed: false });
  expect(await config.grantHost("work", "github.com")).toMatchObject({ changed: false }); // the owner's own already
  await expect(config.grantHost("work", "*.example.org")).rejects.toThrow("a grant names one exact host");
  expect(await text()).toContain("      granted:\n        - api.example.org:8443\n");
  expect((await config.load()).houses[0]!.network.allow).toEqual([{ host: "github.com", port: 443 }, { host: "api.example.org", port: 8443, reach: "public" }]);
  // The owner listing it on purpose makes it theirs (it may then reach a private address): it leaves `granted`.
  expect(await config.allowHost("work", "api.example.org:8443")).toMatchObject({ changed: true });
  expect((await config.load()).houses[0]!.network.allow).toEqual([{ host: "github.com", port: 443 }, { host: "api.example.org", port: 8443 }]);
  await config.disallowHost("work", "api.example.org:8443");
  await config.grantHost("work", "docs.example.org");
  expect(await config.disallowHost("work", "docs.example.org")).toMatchObject({ changed: true }); // removed from either list
  expect((await config.load()).houses[0]!.network.allow).toEqual([{ host: "github.com", port: 443 }]);
  await expect(store("houses:\n  work:\n    network: {allow: [], granted: ['*']}\n").config.load()).rejects.toThrow("a grant names one exact host");
});

test("house features default previews off and persist owner-controlled preview settings", async () => {
  const { houseFeatures } = await import("../../src/core/house-features");
  const { config, text } = store();
  await config.createHouse("work");
  expect(houseFeatures((await config.load()).houses[0]!)).toEqual({ preview: false, sideworkers: true, scouts: false });
  await config.setHouseFeatures("work", { features: { preview: true, sideworkers: false }, preview: { bindAddress: "0.0.0.0", publicHost: "preview.example.com" } });
  expect((await config.load()).houses[0]).toMatchObject({ features: { preview: true, sideworkers: false }, preview: { bindAddress: "0.0.0.0", publicHost: "preview.example.com" } });
  const before = await text();
  await expect(config.setHouseFeatures("work", { features: { preview: true }, preview: { bindAddress: "127.0.0.1", publicHost: "http://localhost:8780" } })).rejects.toThrow();
  expect(await text()).toBe(before);
});

test("a pet's lifecycle is written whole, a multi-line message as a block, read back; null removes it", async () => {
  const { config, text } = store("houses:\n  work:\n    network:\n      allow:\n    pets:\n      sibling:\n");
  await config.updatePet("work", "sibling", { lifecycle: { enabled: true, every: "weekly", at: "04:00", weekday: "sunday", day: 5, notice: 10, shutdown: "Save.\nThen stop." } });
  expect(await text()).toContain("      sibling:\n        lifecycle:\n          enabled: true\n          every: weekly\n          at: 04:00\n          notice: 10\n          weekday: sunday\n          shutdown: |-\n            Save.\n            Then stop.\n");
  expect((await config.load()).houses[0]!.pets[0]!.lifecycle).toEqual({ enabled: true, every: "weekly", at: "04:00", weekday: "sunday", notice: 10, shutdown: "Save.\nThen stop." });
  await config.updatePet("work", "sibling", { lifecycle: null });
  expect((await config.load()).houses[0]!.pets[0]!.lifecycle).toBeUndefined();
  expect(await text()).not.toContain("lifecycle");
});

test("Slack DM configuration round-trips alongside Telegram; workspace identities and app token are retained", async () => {
  const { config } = store("houses:\n  work:\n    network: {allow: []}\n    pets:\n      sibling:\n");
  await config.addOwner("work", "slack", "TTEST:UOWNER");
  await config.addChannel("work", { kind: "slack-private", chat: "TTEST:DTEST", token: "xoxb-synthetic-0000000000000000", appToken: "xapp-1-ATEST-synthetic-00000000", pets: ["sibling"] });
  const house = (await config.load()).houses[0]!;
  expect(house.people.owners).toContainEqual({ platform: "slack", id: "TTEST:UOWNER" });
  expect(house.channels[0]).toMatchObject({ kind: "slack-private", chat: "TTEST:DTEST", appToken: "xapp-1-ATEST-synthetic-00000000" });
  await expect(config.addChannel("work", { kind: "slack-private", chat: "TTEST:CGROUP", token: "xoxb-fake", appToken: "xapp-fake", pets: [] })).rejects.toThrow("workspace:DM");
  await expect(config.addChannel("work", { kind: "slack-private", chat: "TTEST:DOTHER", token: "xoxb-fake", pets: [] })).rejects.toThrow("appToken");
});

test("connecting a channel and its owner is atomic and preserves an existing owner's note", async () => {
  const { config, text } = store();
  await config.createHouse("work");
  const before = await text();
  await expect(config.addChannel("work", { kind: "telegram-private", token: "bot", chat: "123", pets: ["missing"] }, [], { platform: "telegram", id: "123" })).rejects.toThrow();
  expect(await text()).toBe(before);
  await config.addChannel("work", { kind: "telegram-private", token: "bot", chat: "123" }, [], { platform: "telegram", id: "123" });
  expect((await config.load()).houses[0]!.people.owners).toEqual([{ platform: "telegram", id: "123" }]);
  await config.updateOwner("work", "telegram", "123", "keep me");
  await config.addChannel("work", { kind: "telegram-private", token: "bot", chat: "456" }, [], { platform: "telegram", id: "123" });
  expect((await config.load()).houses[0]!.people.owners).toEqual([{ platform: "telegram", id: "123", note: "keep me" }]);
});

test("Telegram forum groups persist negative supergroup ids and reject private/basic group ids", async () => {
  const {config} = store("houses:\n  work:\n    network: {allow: []}\n    pets:\n      sibling: {}\n");
  await config.addChannel("work", {kind:"telegram-group", token:"123456:fake-token", chat:"-1001234567890", pets:["sibling"]});
  expect((await config.load()).houses[0]!.channels[0]).toMatchObject({kind:"telegram-group",chat:"-1001234567890",pets:["sibling"]});
  for (const chat of ["1234567890", "-12345", "-1009007199254740992"]) {
    await expect(config.addChannel("work", {kind:"telegram-group", token:"123456:fake-token",chat,pets:[]})).rejects.toThrow();
  }
});
