import { PetInstructions } from "../../src/infra/pet-instructions";
import { HouseSkills } from "../../src/infra/house-skills";
import { tempDir } from "../helpers";
import { expect, test } from "bun:test";
import type { AgentAdapter } from "../../src/core/agent";
import type { PlacedPet } from "../../src/app/agents";
import { PetPlane, petChange } from "../../src/app/pet-plane";
import { FakeRuntime } from "./fake-runtime";

const agent: AgentAdapter = {
  name: "fake-agent",
  imageContext: "/adapters/fake",
  home: "/home/fake",
  env: ({ caCertPath, eventsUrl, model, reasoningEffort, mode }) => ({ TRUST: caCertPath, EVENTS: eventsUrl, MODEL: model, ...(reasoningEffort === undefined ? {} : { EFFORT: reasoningEffort }), ...(mode ? { MODE: mode } : {}) }),
  models: ["small", "big"],
  defaultModel: "small",
  providers: ["anthropic"],
  useKey: () => ({ kind: "test", env: {}, wire: [] }),
  credentialHeaders: [],
  async isReady(exec, mode) {
    const { output } = await exec(["screen"]);
    const warning = mode && !output.includes(mode) ? { warning: `runs in another mode than ${mode}` } : {};
    return { ready: output.includes("READY"), output, ...warning };
  },
  translate: () => [],
  send: async () => ({ status: "sent" }),
  dialogVisible: async () => false,
};

const keyUse = { kind: "subscription", env: { KEY: "key-placeholder" }, wire: [] };
const pets: PlacedPet[] = [
  { house: "work", pet: "sibling", agent, model: "small", key: "k", keyUse },
  { house: "work", pet: "chair", agent, model: "small", key: "k", keyUse },
];

/** How the pets reach the gateway: its host and ports, and a token each. */
const TRANSPORT = { host: "host.microsandbox.internal", proxyPort: 3128, relayPort: 8080, tokenFor: ({ pet }: { pet: string }) => `token-${pet}` };

function setup(timeoutMs = 50) {
  const runtime = new FakeRuntime();
  runtime.output = () => "READY";
  return { runtime, plane: new PetPlane(runtime, "/state/tls/ca.crt", "me", timeoutMs, TRANSPORT) };
}

test("missing pets are started: own image, labels, limits, home volume, CA, proxy, relay", async () => {
  const { runtime, plane } = setup();
  const result = await plane.reconcile(pets);
  expect(result).toEqual({ started: pets, removed: [] });
  expect(await plane.awaitReady(result.started)).toEqual([
    { house: "work", pet: "sibling", ready: true },
    { house: "work", pet: "chair", ready: true },
  ]);
  expect(runtime.calls.filter((call) => call.startsWith("build"))).toEqual(["build household-agent-fake-agent"]);
  expect(runtime.specs[0]).toEqual({
    name: "household.work.sibling",
    image: "household-agent-fake-agent",
    env: {
      TRUST: "/etc/household/ca.crt",
      EVENTS: "http://host.microsandbox.internal:8080/events",
      MODEL: "small",
      KEY: "key-placeholder", // the key's placeholder, by its kind (its value is the gateway's)
      HTTPS_PROXY: "http://household:token-sibling@host.microsandbox.internal:3128",
      NO_PROXY: "host.microsandbox.internal",
      https_proxy: "http://household:token-sibling@host.microsandbox.internal:3128",
      no_proxy: "host.microsandbox.internal",
      PLAYWRIGHT_BROWSERS_PATH: "/opt/household/playwright", // where root's installs of per-user tools went
      RUSTUP_HOME: "/opt/household/rustup",
      HOUSEHOLD_PET_TOKEN: "token-sibling",
    },
    labels: {
      "household.owner": "me", "household.house": "work", "household.pet": "sibling",
      "household.identity": expect.stringMatching(/^[0-9a-f]{16}$/), "household.launch": expect.stringMatching(/^[0-9a-f]{16}$/),
    },
    mounts: [
      { type: "volume", source: "household.work.sibling.home", target: "/home/fake" },
      { type: "bind", source: "/state/tls/ca.crt", target: "/etc/household/ca.crt", readOnly: true },
      { type: "disk", source: "household.work.sibling.docker", target: "/var/lib/docker", size: "10G" },
    ],
    cpus: 2,
    limits: { pids: 512, memory: "1024M" },
  });
});

test("names cannot collide across houses", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile([
    { house: "work-x", pet: "y", agent, model: "small", key: "k", keyUse },
    { house: "work", pet: "x-y", agent, model: "small", key: "k", keyUse },
  ]);
  expect(runtime.specs.map((spec) => spec.name)).toEqual(["household.work-x.y", "household.work.x-y"]);
});

test("a running pet with the same VM is adopted, an exited one started; a changed identity is a new VM on the same disks", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile(pets);
  runtime.calls = [];
  expect(await plane.reconcile(pets)).toMatchObject({ started: [], removed: [] });
  expect(runtime.calls).toEqual([]); // the image is built once per daemon run

  // A paused pet (an export reading its home) is alive: adopted, not recreated.
  runtime.containers.get("household.work.sibling")!.state = "paused";
  expect(await plane.reconcile(pets)).toMatchObject({ started: [], removed: [] });
  expect(runtime.calls).toEqual([]);

  // A dead agent's VM is started again; another identity (a foreign label here) is a new VM.
  runtime.containers.get("household.work.chair")!.state = "exited";
  runtime.containers.get("household.work.sibling")!.labels["household.identity"] = "someone-elses";
  runtime.calls = [];
  const { started } = await plane.reconcile(pets);
  expect(started.map((s) => s.pet)).toEqual(["sibling", "chair"]);
  expect(runtime.calls).toEqual(["rm household.work.sibling", "run household.work.sibling", "start household.work.chair"]);

  // New image content changes the identity, so a fresh daemon recreates even running pets, on the same Docker disks.
  runtime.imageVersion = 2;
  const fresh = new PetPlane(runtime, "/state/tls/ca.crt", "me", 50, TRANSPORT);
  expect((await fresh.reconcile(pets)).started).toHaveLength(2);
  expect([...runtime.disks]).toEqual(["household.work.sibling.docker", "household.work.chair.docker"]);
  expect(runtime.calls.some((call) => call.startsWith("rm disk"))).toBe(false);
});

test("a changed launch configuration restarts the same VM with it: model, mode, key kind, instructions", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile(pets);
  const stopped: string[] = [];
  const onStopped = async ({ pet }: { pet: string }) => { stopped.push(pet); };
  const relaunched = async (wanted: PlacedPet[]) => {
    runtime.calls = [];
    const { started } = await plane.reconcile(wanted, onStopped);
    return started.map((pet) => pet.pet);
  };
  const why: string[] = [];
  plane.onRelaunch((_, pet, reason) => why.push(`${pet}: ${reason.kind === "relaunch" ? reason.changed?.join(",") : reason.kind}`));
  const chair = runtime.containers.get("household.work.chair")!;
  expect(await relaunched([pets[0]!, { ...pets[1]!, model: "big" }])).toEqual(["chair"]);
  expect(runtime.calls).toEqual(["stop household.work.chair", "launch household.work.chair", "start household.work.chair"]);
  expect(why).toEqual(["chair: MODEL"]); // what changed, by name only
  expect(stopped).toEqual(["chair"]);
  expect(runtime.containers.get("household.work.chair")).toBe(chair); // not recreated
  expect(runtime.specs).toHaveLength(2);
  expect(chair.env!.MODEL).toBe("big");
  expect(await relaunched([pets[0]!, { ...pets[1]!, model: "big" }])).toEqual([]);
  // So is another permission mode: it goes to the agent's launch.
  expect(await relaunched([pets[0]!, { ...pets[1]!, model: "big", mode: "careful" }])).toEqual(["chair"]);
  expect(chair.env!.MODE).toBe("careful");
  // Another key of the same kind changes nothing (the gateway swaps the value); another kind relaunches.
  expect(await relaunched([pets[0]!, { ...pets[1]!, model: "big", mode: "careful", key: "other" }])).toEqual([]);
  expect(await relaunched([pets[0]!, { ...pets[1]!, model: "big", mode: "careful", keyUse: { ...keyUse, env: { OTHER_KEY: "x" } } }])).toEqual(["chair"]);
  expect(chair.env).toMatchObject({ OTHER_KEY: "x" });
  expect(chair.env!.KEY).toBeUndefined();
  // A stopped VM takes the new configuration without being stopped again.
  chair.state = "stopped";
  stopped.length = 0;
  expect(await relaunched([pets[0]!, { ...pets[1]!, model: "small" }])).toEqual(["chair"]);
  expect(runtime.calls).toEqual(["launch household.work.chair", "start household.work.chair"]);
  expect(stopped).toEqual([]);
  expect(runtime.calls.some((call) => call.startsWith("rm") || call.startsWith("run"))).toBe(false);
});

test("what a change does: identity before launch configuration, a stopped VM never replaced", () => {
  const vm = (state: string, identity = "i", launch = "l") => ({ name: "vm", state, labels: { "household.identity": identity, "household.launch": launch } });
  const wanted = { identity: "i", launch: "l" };
  expect(petChange(undefined, wanted)).toBe("create");
  expect(petChange(vm("running"), wanted)).toBe("adopt");
  expect(petChange(vm("paused"), wanted)).toBe("adopt");
  expect(petChange(vm("exited"), wanted)).toBe("start");
  expect(petChange(vm("stopped"), wanted)).toBe("start");
  expect(petChange(vm("running", "i", "old"), wanted)).toBe("relaunch");
  expect(petChange(vm("stopped", "i", "old"), wanted)).toBe("relaunch");
  expect(petChange(vm("running", "old", "old"), wanted)).toBe("recreate");
  expect(petChange(vm("paused", "old"), wanted)).toBe("recreate");
  expect(petChange(vm("stopped", "old"), wanted)).toBe("recreate"); // an enabled pet is meant to run
  expect(petChange(vm("exited", "old"), wanted)).toBe("recreate");
});

test("the instructions are launch configuration, the gateway's ports identity", async () => {
  const runtime = new FakeRuntime();
  const plane = (proxyPort: number) => new PetPlane(runtime, "/state/tls/ca.crt", "me", 50, { ...TRANSPORT, proxyPort });
  await plane(3128).reconcile([pets[0]!]);
  const { "household.identity": identity, "household.launch": launch } = runtime.specs[0]!.labels!;
  const instructed = { ...agent, env: (options: Parameters<AgentAdapter["env"]>[0]) => ({ ...agent.env(options), INSTRUCTIONS: `${options.instructions}\nOne more sentence.` }) };
  const plan = await plane(3128).reconcile([{ ...pets[0]!, agent: instructed }]);
  expect(plan.started).toHaveLength(1);
  expect(runtime.specs).toHaveLength(1);
  const sibling = runtime.containers.get("household.work.sibling")!;
  expect(sibling.labels["household.identity"]).toBe(identity!);
  expect(sibling.labels["household.launch"]).not.toBe(launch);
  // The VM's network rules open the gateway's ports at creation: other ports, a new VM.
  await plane(4128).reconcile([{ ...pets[0]!, agent: instructed }]);
  expect(runtime.specs).toHaveLength(2);
});

test("containers of pets gone from the config are removed with their Docker disks, other instances' pets are not", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile(pets);
  runtime.containers.set("household.home.other", { state: "running", labels: { "household.owner": "you" } });
  runtime.disks.add("household.home.other.docker");
  runtime.calls = [];
  expect((await plane.reconcile([pets[0]!])).removed).toEqual(["household.work.chair"]);
  expect(runtime.calls).toEqual(["rm household.work.chair", "rm disk household.work.chair.docker"]);
  expect(runtime.containers.has("household.home.other")).toBe(true);
  expect([...runtime.disks]).toEqual(["household.work.sibling.docker", "household.home.other.docker"]);
});

test("a pet that never gets ready is reported with what the check saw", async () => {
  const { runtime, plane } = setup();
  runtime.output = () => "Do you trust this folder?";
  const { started } = await plane.reconcile([pets[0]!]);
  expect(await plane.awaitReady(started)).toEqual([
    { house: "work", pet: "sibling", ready: false, output: "Do you trust this folder?" },
  ]);
});

test("an agent whose process exits is reported at once, with the reason it left behind", async () => {
  const { runtime, plane } = setup(60_000);
  let checks = 0;
  // The first check finds nothing; by the next the agent has written why it stopped (the codex bridge's failure file).
  runtime.output = () => checks++ === 0 ? "" : "Codex startup failed while resuming the saved conversation";
  const { started } = await plane.reconcile([pets[0]!]);
  runtime.containers.get("household.work.sibling")!.state = "exited";
  const before = Date.now();
  expect(await plane.awaitReady(started)).toEqual([
    { house: "work", pet: "sibling", ready: false, exited: true, output: "Codex startup failed while resuming the saved conversation" },
  ]);
  expect(Date.now() - before).toBeLessThan(2000);
});

test("a ready pet in another permission mode than its own is reported with the agent's warning", async () => {
  const { plane } = setup();
  const { started } = await plane.reconcile([{ ...pets[0]!, mode: "careful" }]);
  expect(await plane.awaitReady(started)).toEqual([{ house: "work", pet: "sibling", ready: true, warning: "runs in another mode than careful" }]);
});

test("stopWaiting cuts a readiness wait short", async () => {
  const { runtime, plane } = setup(60_000);
  runtime.output = () => "";
  const started = Date.now();
  const waiting = plane.awaitReady([pets[0]!]);
  await Bun.sleep(100);
  plane.stopWaiting();
  expect((await waiting)[0]!.ready).toBe(false);
  expect(Date.now() - started).toBeLessThan(2000);
});

test("status comes from one container listing", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile([pets[0]!]);
  expect(await plane.status(pets)).toEqual([
    { house: "work", pet: "sibling", agent: "fake-agent", container: "household.work.sibling", state: "running" },
    { house: "work", pet: "chair", agent: "fake-agent", container: "household.work.chair", state: "missing" },
  ]);
});

test("status survives a VM disappearing during inventory without hiding other pets or weakening reconcile", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile(pets);
  const container = runtime.container.bind(runtime);
  runtime.listContainers = async () => { throw new Error("microsandbox main job inspection failed"); };
  runtime.container = async (name) => {
    if (name.endsWith(".sibling")) throw new Error("inspection raced with removal");
    return container(name);
  };
  expect((await plane.status(pets)).map(({ state }) => state)).toEqual(["unknown", "running"]);
  runtime.container = async (name) => name.endsWith(".sibling") ? undefined : container(name);
  expect((await plane.status(pets)).map(({ state }) => state)).toEqual(["missing", "running"]);
  const before = runtime.calls.length;
  await expect(plane.reconcile(pets)).rejects.toThrow("microsandbox main job inspection failed");
  expect(runtime.calls).toHaveLength(before);
});


test("microVM transport uses per-pet capabilities and host services without Docker networks", async () => {
  const runtime = new FakeRuntime();
  const plane = new PetPlane(runtime, "/state/tls/ca.crt", "me", 50, TRANSPORT);
  await plane.reconcile(pets);
  expect(runtime.specs[0]!.env).toMatchObject({
    HTTPS_PROXY: "http://household:token-sibling@host.microsandbox.internal:3128",
    NO_PROXY: "host.microsandbox.internal", HOUSEHOLD_PET_TOKEN: "token-sibling",
    EVENTS: "http://host.microsandbox.internal:8080/events",
  });
  expect(runtime.specs[1]!.env!.HOUSEHOLD_PET_TOKEN).toBe("token-chair");
});


test("a foreign same-name pet is refused before any lifecycle mutations", async () => {
  const { runtime, plane } = setup();
  runtime.containers.set("household.work.sibling", { state: "running", labels: { "household.owner": "another-household" } });
  await expect(plane.reconcile(pets)).rejects.toThrow("another Household");
  expect(runtime.calls).toEqual([]);
  expect(runtime.containers.get("household.work.sibling")!.labels["household.owner"]).toBe("another-household");
});


test("reasoning effort reaches the launch and changing or clearing it relaunches only that pet", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile(pets);
  const chair = runtime.containers.get("household.work.chair")!;
  expect(chair.env!.EFFORT).toBeUndefined();
  const selected = [pets[0]!, { ...pets[1]!, reasoningEffort: "high" }];
  expect((await plane.reconcile(selected)).started.map(({ pet }) => pet)).toEqual(["chair"]);
  expect(chair.env!.EFFORT).toBe("high");
  expect((await plane.reconcile(selected)).started).toEqual([]);
  expect((await plane.reconcile([pets[0]!, { ...pets[1]!, reasoningEffort: "low" }])).started.map(({ pet }) => pet)).toEqual(["chair"]);
  expect((await plane.reconcile(pets)).started.map(({ pet }) => pet)).toEqual(["chair"]);
  expect(chair.env!.EFFORT).toBeUndefined();
  expect(runtime.containers.get("household.work.chair")).toBe(chair);
});

test("environment setup rerun checks the current VM's ownership and running state without recreating it", async () => {
  const calls: string[] = [];
  const result = { status: "complete" as const, logPath: "/home/fake/environment/setup.log", statusPath: "/home/fake/environment/setup.status" };
  const runtime = Object.assign(new FakeRuntime(), {
    runEnvironmentSetup: async (name: string) => { calls.push(name); return result; },
    environmentSetupResult: () => result,
  });
  const plane = new PetPlane(runtime, "/state/tls/ca.crt", "me", 60_000, TRANSPORT);
  await expect(plane.runEnvironmentSetup("work", "sibling")).rejects.toThrow("unavailable");
  await plane.reconcile(pets);
  const count = runtime.calls.length;
  expect(await plane.runEnvironmentSetup("work", "sibling")).toEqual(result);
  expect(calls).toEqual(["household.work.sibling"]);
  expect(runtime.calls.slice(count)).toEqual([]);
  expect(plane.environmentSetupResult("work", "sibling")).toEqual(result);
  runtime.containers.get("household.work.sibling")!.state = "paused";
  await expect(plane.runEnvironmentSetup("work", "sibling")).rejects.toThrow("unavailable");
  const container = runtime.containers.get("household.work.sibling")!;
  container.state = "running";
  container.labels["household.owner"] = "other";
  await expect(plane.runEnvironmentSetup("work", "sibling")).rejects.toThrow("unavailable");
  expect(calls).toHaveLength(1);
});


test("saved environment edits and clears refresh adopted VM setup without recreating it", async () => {
  const configured: [string, string | undefined][] = [];
  const executed: [string, string | undefined][] = [];
  const runtime = Object.assign(new FakeRuntime(), {
    configureEnvironmentSetup: (name: string, script?: string) => { configured.push([name, script]); },
    runEnvironmentSetup: async (name: string, script?: string) => {
      executed.push([name, script]);
      return { status: "complete" as const, logPath: "~/environment/setup.log", statusPath: "~/environment/setup.status" };
    },
  });
  const plane = new PetPlane(runtime, "/state/tls/ca.crt", "me", 60_000, TRANSPORT);
  const first = [{ ...pets[0]!, environment: { setup: "first" } }];
  await plane.reconcile(first);
  expect(runtime.specs[0]!.environmentSetup).toBe("first");
  const lifecycleCalls = [...runtime.calls];
  const latest = [{ ...pets[0]!, environment: { setup: "saved latest" } }];
  expect((await plane.reconcile(latest)).started).toHaveLength(0);
  expect(runtime.calls).toEqual(lifecycleCalls);
  expect(configured.at(-1)).toEqual(["household.work.sibling", "saved latest"]);
  await plane.runEnvironmentSetup("work", "sibling", "saved latest");
  expect(executed.at(-1)).toEqual(["household.work.sibling", "saved latest"]);
  expect((await plane.reconcile([pets[0]!])).started).toHaveLength(0);
  expect(configured.at(-1)).toEqual(["household.work.sibling", undefined]);
  expect(runtime.calls).toEqual(lifecycleCalls);
});

test("explicit restart stops/starts the same owned VM and uses latest setup", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile(pets);
  const calls: string[] = [];
  Object.assign(runtime, {
    configureEnvironmentSetup: (name: string, setup?: string) => calls.push(`setup ${name} ${setup}`),
    stopContainer: async (name: string) => { calls.push(`stop ${name}`); runtime.containers.get(name)!.state = "stopped"; },
    startContainer: async (name: string) => { calls.push(`start ${name}`); runtime.containers.get(name)!.state = "running"; },
  });
  runtime.calls = [];
  await plane.restart({ ...pets[0]!, environment: { setup: "printf latest" } }, async () => { calls.push("leave"); });
  expect(calls).toEqual(["setup household.work.sibling printf latest", "leave", "stop household.work.sibling", "start household.work.sibling"]);
  expect(runtime.calls).toEqual([]); // no remove, create or build
  expect(runtime.containers.size).toBe(2);
  for (const state of ["foreign", "paused", "missing"]) {
    const item = runtime.containers.get("household.work.sibling")!;
    if (state === "foreign") item.labels["household.owner"] = "other";
    if (state === "paused") { item.labels["household.owner"] = "me"; item.state = "paused"; }
    if (state === "missing") runtime.containers.delete("household.work.sibling");
    await expect(plane.restart(pets[0]!)).rejects.toThrow();
  }
  expect(calls).toHaveLength(4); // nothing more after the refusals
});

test("terminal capture uses only the adapter's fixed pane and bounds output", async () => {
  const { claudeCodeTmux } = await import("../../src/agent-adapters/claude-code-tmux");
  const { runtime, plane } = setup();
  const placed = { ...pets[0]!, agent: claudeCodeTmux };
  await plane.reconcile([placed]);
  runtime.output = () => "x".repeat(80_000) + "<script>plain text</script>\n";
  const snapshot = await plane.terminalSnapshot(placed);
  expect(snapshot?.text.endsWith("<script>plain text</script>\n")).toBe(true);
  expect(Buffer.byteLength(snapshot!.text)).toBe(64 * 1024);
  expect(runtime.execs).toEqual(["household.work.sibling: tmux capture-pane -p -t =main:0.0 -S -200"]);
  runtime.output = () => "🤖".repeat(20_000) + "❯";
  const unicode = (await plane.terminalSnapshot(placed))!.text;
  expect(unicode).not.toContain("�");
  expect(Buffer.byteLength(unicode)).toBeLessThanOrEqual(64 * 1024);
  expect(unicode.endsWith("❯")).toBe(true);
});

test("terminal refuses unsupported, missing, stopped, paused and foreign VMs without execution", async () => {
  const { runtime, plane } = setup();
  const placed = { ...pets[0]!, agent: { ...agent, terminalSnapshot: ["capture", "fixed"] } };
  expect(await plane.terminalSnapshot(placed)).toBeUndefined();
  await plane.reconcile([placed]);
  expect(await plane.terminalSnapshot(pets[0]!)).toBeUndefined();
  const vm = runtime.containers.get("household.work.sibling")!;
  for (const state of ["exited", "paused"]) {
    vm.state = state;
    expect(await plane.terminalSnapshot(placed)).toBeUndefined();
  }
  vm.state = "running";
  vm.labels["household.owner"] = "another";
  expect(await plane.terminalSnapshot(placed)).toBeUndefined();
  expect(runtime.execs).toEqual([]);
});

test("terminal coalesces in-flight reads and hides failed guest captures", async () => {
  const { runtime, plane } = setup();
  const placed = { ...pets[0]!, agent: { ...agent, terminalSnapshot: ["capture", "fixed"] } };
  await plane.reconcile([placed]);
  let finish!: (value: { ok: boolean; output: string }) => void;
  let calls = 0;
  runtime.exec = async () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  const first = plane.terminalSnapshot(placed);
  const second = plane.terminalSnapshot(placed);
  expect(first).toBe(second);
  await Bun.sleep(0);
  finish({ ok: false, output: "private failure" });
  expect(await first).toBeUndefined();
  expect(calls).toBe(1);
  runtime.exec = async () => { throw new Error("private transport failure"); };
  expect(await plane.terminalSnapshot(placed)).toBeUndefined();
});


test("pets in a house share one writable skills mount; other houses get a different directory", async () => {
  const runtime = new FakeRuntime(); const skills = new HouseSkills(tempDir());
  const plane = new PetPlane(runtime, "/ca.crt", "me", 50, TRANSPORT, skills);
  const skilled = {...agent,skillsDirectory:".claude/skills"};
  await plane.reconcile([...pets.map(p => ({...p,agent:skilled})), {...pets[0]!,house:"other",agent:skilled}]);
  const mounts = runtime.specs.map(spec => spec.mounts!.find(m => m.target === "/opt/household/skills")!);
  expect(mounts[0]!.source).toBe(mounts[1]!.source);
  expect(mounts[0]!.source).not.toBe(mounts[2]!.source);
  expect(mounts.every(m => m.type === "bind" && !m.readOnly)).toBe(true);
  expect(runtime.specs.every(s => s.env!.HOUSEHOLD_SKILLS_DIRECTORY === ".claude/skills")).toBe(true);
  expect(await skills.list("work")).toEqual([]);
  // The fake records the launched specs separately from runtime inspection state.
  expect(runtime.calls.filter(call => call.startsWith("run ")).length).toBe(3);
});

test("explicit restart brings the VM's launch configuration up to date while it is stopped", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile(pets);
  runtime.calls = [];
  await plane.restart({ ...pets[0]!, model: "big" });
  expect(runtime.calls).toEqual(["stop household.work.sibling", "launch household.work.sibling", "start household.work.sibling"]);
  expect(runtime.containers.get("household.work.sibling")!.env!.MODEL).toBe("big");
  runtime.calls = [];
  await plane.restart({ ...pets[0]!, model: "big" });
  expect(runtime.calls).toEqual(["stop household.work.sibling", "start household.work.sibling"]);
});

test("explicit restart detaches native session only after VM stops, including already stopped VMs", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile(pets);
  const calls: string[] = [];
  Object.assign(runtime, {
    stopContainer: async () => { calls.push("stop"); },
    resetSession: async (volume: string, file: string) => { calls.push(`reset ${volume} ${file}`); },
    startContainer: async () => { calls.push("start"); },
  });
  const pet = { ...pets[0]!, agent: { ...pets[0]!.agent, sessionFile: ".thread" } };
  for (const state of ["running", "stopped"]) {
    runtime.containers.get("household.work.sibling")!.state = state;
    calls.length = 0;
    await plane.restart(pet, async () => { calls.push("suspend"); });
    expect(calls).toEqual(["suspend", "stop", "reset household.work.sibling.home .thread", "start"]);
  }
  calls.length = 0;
  Object.assign(runtime, { resetSession: async () => { throw new Error("reset failed"); } });
  await expect(plane.restart(pet)).rejects.toThrow("reset failed");
  expect(calls).toEqual(["stop"]); // Never start the old session after a failed reset.
});

test("disable stops the existing VM; enable starts it without replacing disks", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile(pets);
  const original = runtime.containers.get("household.work.sibling")!;
  Object.assign(runtime, {
    stopContainer: async (name: string) => { runtime.calls.push(`stop ${name}`); runtime.containers.get(name)!.state = "stopped"; },
    startContainer: async (name: string) => { runtime.calls.push(`start ${name}`); runtime.containers.get(name)!.state = "running"; },
  });
  runtime.calls = [];
  const disabled = [{ ...pets[0]!, enabled: false }, pets[1]!];
  const result = await plane.reconcile(disabled);
  expect(runtime.calls).toEqual(["stop household.work.sibling"]);
  expect(result.started).toHaveLength(0);
  expect(result.removed).toHaveLength(0);
  expect((await plane.status(disabled))[0]!.state).toBe("disabled");
  runtime.calls = [];
  await plane.reconcile(disabled);
  expect(runtime.calls).toEqual([]);
  const enabled = await plane.reconcile(pets);
  expect(enabled.started).toEqual([pets[0]!]);
  expect(runtime.calls).toEqual(["start household.work.sibling"]);
  expect(runtime.containers.get("household.work.sibling")).toBe(original);
  await expect(plane.restart(disabled[0]!)).rejects.toThrow("disabled");
});

test("a disabled pet with no VM is not built or started", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile([{ ...pets[0]!, enabled: false }]);
  expect(runtime.calls).toEqual([]);
  expect(runtime.containers.size).toBe(0);
});

test("disable also stops an exited main job's still-resident VM", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile(pets);
  runtime.containers.get("household.work.sibling")!.state = "exited";
  let stopped = false;
  Object.assign(runtime, { stopContainer: async (name: string) => { stopped = true; runtime.containers.get(name)!.state = "stopped"; } });
  await plane.reconcile([{ ...pets[0]!, enabled: false }, pets[1]!]);
  expect(stopped).toBe(true);
});

test("a stopped VM whose identity changed is recreated, and the other pets are reconciled all the same", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile(pets);
  runtime.containers.get("household.work.sibling")!.state = "stopped";
  runtime.calls = [];
  runtime.imageVersion = 2;
  const fresh = new PetPlane(runtime, "/state/tls/ca.crt", "me", 50, TRANSPORT);
  const { started } = await fresh.reconcile(pets);
  expect(started.map(({ pet }) => pet)).toEqual(["sibling", "chair"]);
  expect(runtime.calls).toEqual(expect.arrayContaining(["rm household.work.sibling", "run household.work.sibling", "rm household.work.chair", "run household.work.chair"]));
  expect(runtime.containers.get("household.work.sibling")!.state).toBe("running");
});

test("disable resets the native session after stop, while enable only starts the existing VM", async () => {
  const { runtime, plane } = setup();
  const pet = { ...pets[0]!, agent: { ...agent, sessionFile: ".thread" } };
  await plane.reconcile([pet]);
  const calls: string[] = [];
  Object.assign(runtime, {
    stopContainer: async (name: string) => { calls.push("stop"); runtime.containers.get(name)!.state = "stopped"; },
    resetSession: async () => { calls.push("reset"); },
    startContainer: async (name: string) => { calls.push("start"); runtime.containers.get(name)!.state = "running"; },
  });
  await plane.reconcile([{ ...pet, enabled: false }]);
  expect(calls).toEqual(["stop", "reset"]);
  await plane.reconcile([pet]);
  expect(calls).toEqual(["stop", "reset", "start"]);
});


test("instruction migration errors never prevent adopting or disabling a pet", async () => {
  const { runtime, plane } = setup();
  await plane.reconcile(pets);
  const instructions = new PetInstructions(tempDir());
  let attempts = 0;
  instructions.read = async () => { attempts++; throw new Error("native instructions need migration"); };
  const next = new PetPlane(runtime, "/state/tls/ca.crt", "me", 50, TRANSPORT, undefined, instructions);
  const configured = pets.map(p => ({...p, agent:{...p.agent,instructionsFile:".test/AGENTS.md"}}));
  runtime.calls = [];
  expect((await next.reconcile(configured)).started).toEqual([]);
  expect(attempts).toBe(2);
  expect(runtime.calls.some(c=>c.startsWith("run "))).toBe(false);
  Object.assign(runtime, { stopContainer: async (name: string) => { runtime.containers.get(name)!.state = "stopped"; } });
  await next.reconcile(configured.map(p=>({...p,enabled:false})));
  expect(attempts).toBe(2);
  expect(runtime.containers.get("household.work.sibling")!.state).toBe("stopped");
});

test("monitoring uses physical VM state even with a dead agent, skips disabled and rejects foreign machines", async () => {
  const runtime = new FakeRuntime();
  let reads = 0;
  const plane = new PetPlane(Object.assign(runtime, { machine: async (name: string) => {
    reads++; return { name, state: "running", labels: { "household.owner": name.endsWith("sibling") ? "me" : "other" } };
  } }), "/state/tls/ca.crt", "me", 60_000, TRANSPORT);
  expect((await plane.monitoringStates(pets)).map(p => p.state)).toEqual(["running", "unavailable"]);
  expect((await plane.monitoringStates([{ ...pets[0]!, enabled: false }]))[0]?.state).toBe("disabled");
  expect(reads).toBe(2);
});


test("resource changes stage on the existing VM without changing its identity or restarting it", async () => {
  const runtime = new FakeRuntime();
  const changes: unknown[] = [];
  const plane = new PetPlane(Object.assign(runtime, { configureResources: async (name: string, values: unknown) => { changes.push({name, values}); } }), "/state/tls/ca.crt", "me", 60_000, TRANSPORT);
  await plane.reconcile([pets[0]!]);
  const original = runtime.specs[0]!;
  const result = await plane.reconcile([{...pets[0]!, cpus: 4, memoryMiB: 4096}]);
  expect(result.started).toEqual([]);
  expect(result.removed).toEqual([]);
  expect(runtime.specs).toHaveLength(1);
  expect(changes).toEqual([{name: original.name, values: {cpus: 4, memoryMiB: 4096}}]);
});

test("sideworkers mount private harness home and parent's shared home, with separate identity, token and Docker disk", async () => {
  const { runtime, plane } = setup();
  const workerAgent: AgentAdapter = { ...agent, env: context => ({ ...agent.env(context), HOME: context.home!, WORKSPACE: context.workspace!, INSTRUCTIONS: context.instructions }) };
  const worker: PlacedPet = { ...pets[0]!, pet: "sw-review", agent: workerAgent, sideworker: { parent: "sibling", cwd: "/home/fake/projects/repo" }, cpus: 1, memoryMiB: 512, instructions: "You are sideworker sw-review, dispatched by pet sibling" };
  await plane.reconcile([pets[0]!, worker]);
  const spec = runtime.specs[1]!;
  expect(spec.env).toMatchObject({ HOME: "/home/worker", WORKSPACE: "/home/fake/projects/repo", HOUSEHOLD_PET_TOKEN: "token-sw-review" });
  expect(spec.env!.INSTRUCTIONS).toBe("You are sideworker sw-review, dispatched by pet sibling"); // its prompt, as placed
  expect(spec.mounts).toEqual(expect.arrayContaining([
    { type: "volume", source: "household.work.sw-review.home", target: "/home/worker" },
    { type: "volume", source: "household.work.sibling.home", target: "/home/fake" },
    { type: "disk", source: "household.work.sw-review.docker", target: "/var/lib/docker", size: "10G" },
  ]));
  expect(spec.cpus).toBe(1);
  expect(spec.limits!.memory).toBe("512M");
});

test("scout runs mount only their private material and use scout instructions", async () => {
  const {runtime,plane}=setup();
  const scoutAgent={...agent,env:({home,workspace,instructions,scout}:Parameters<AgentAdapter["env"]>[0])=>({HOME:home!,CWD:workspace!,INSTRUCTIONS:instructions,SCOUT:String(scout)})};
  await plane.reconcile([{...pets[0]!,pet:"sc-a",agent:scoutAgent,scout:{definition:"helper",parent:"sibling",homePath:"/private/run/home",skillsPath:"/private/run/skills",instructions:"Owner's",env:{TASK_SECRET:"private"},setup:"echo scout",network:{kind:"allowlist",allow:[]}},instructions:"SCOUT ONLY"}]);
  const spec=runtime.specs[0]!;
  expect(spec.env?.INSTRUCTIONS).toBe("SCOUT ONLY");
  expect(spec.env?.SCOUT).toBe("true");
  expect(spec.env?.HOME).toBe("/home/fake");expect(spec.env?.CWD).toBe("/work");
  expect(spec.environmentSetup).toBe("echo scout");
  expect(spec.mounts?.some(m=>m.source.includes("sibling"))).toBe(false);
  expect(spec.mounts?.filter(m=>m.type==="volume")).toHaveLength(0);
  expect(spec.mounts?.some(m=>m.target==="/work")).toBe(false);
  expect(spec.mounts?.find(m=>m.target==="/run/household/secrets")?.source).toBe("/private/run/home/../secrets");
  expect(spec.mounts?.find(m=>m.target==="/opt/household/skills")?.source).toBe("/private/run/skills");
});

test("staged reductions remain reserved across daemon adoption until the VM restarts", async () => {
  const { workspaceBudget } = await import("../../src/core/resources");
  const runtime = new FakeRuntime();
  let active = { cpus: 6, memoryMiB: 6144 }, staged = active;
  const list = runtime.listContainers.bind(runtime), start = runtime.startContainer.bind(runtime);
  runtime.listContainers = async label => (await list(label)).map(vm => ({ ...vm, ...(["running", "paused"].includes(vm.state) ? { resources: { ...active } } : {}) }));
  runtime.startContainer = async name => { await start(name); active = staged; };
  const managed = Object.assign(runtime, { configureResources: async (_name: string, value: typeof active) => { staged = value; } });
  const plane = new PetPlane(managed, "/ca", "me", 50, TRANSPORT);
  const large = { ...pets[0]!, ...active }, small = { ...pets[0]!, cpus: 2, memoryMiB: 1024 };
  await plane.reconcile([large]);
  await plane.reconcile([small]);
  const house = { resources: { cpus: 8, memoryMiB: 8192 }, pets: [{ name: small.pet, cpus: 2, memoryMiB: 1024 }] };
  expect(workspaceBudget(house, plane.resourceAllocations("work")).available.cpus).toBe(2);
  const adopted = new PetPlane(managed, "/ca", "me", 50, TRANSPORT);
  await adopted.refreshResources();
  expect(workspaceBudget(house, adopted.resourceAllocations("work")).available.cpus).toBe(2);
  await adopted.restart(small);
  expect(workspaceBudget(house, adopted.resourceAllocations("work")).available).toEqual({ cpus: 6, memoryMiB: 7168 });
});

test("volumes: mounted at /volumes/<name>; a folder gone or back recreates nothing on reload, but Restart remounts it", async () => {
  const { mkdir, rm, realpath } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = await realpath(tempDir());
  const folder = join(dir, "photos");
  await mkdir(folder);
  const { runtime, plane } = setup();
  const pet: PlacedPet = { ...pets[0]!, volumes: [{ name: "photos", path: folder, access: "read" }] };
  await plane.reconcile([pet]);
  expect(runtime.specs[0]!.mounts).toContainEqual({ type: "bind", source: folder, target: "/volumes/photos", readOnly: true });
  expect(runtime.specs[0]!.labels!["household.volumes"]).toBe("photos:ro");
  await rm(folder, { recursive: true });
  runtime.specs.length = 0;
  await plane.reconcile([pet]);
  expect(runtime.specs).toEqual([]); // an unplugged disk restarts no bot
  await plane.restart(pet);
  expect(runtime.specs[0]!.mounts!.some((mount) => mount.target === "/volumes/photos")).toBe(false); // a new VM without it
  await mkdir(folder);
  runtime.specs.length = 0;
  await plane.restart(pet);
  expect(runtime.specs[0]!.mounts).toContainEqual({ type: "bind", source: folder, target: "/volumes/photos", readOnly: true });
});

test("volumes: a stopped VM whose folder is gone is made anew without it, so it still starts", async () => {
  const { mkdir, rm, realpath } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = await realpath(tempDir());
  const folder = join(dir, "nas");
  await mkdir(folder);
  const { runtime, plane } = setup();
  const pet: PlacedPet = { ...pets[0]!, volumes: [{ name: "nas", path: folder, access: "write" }] };
  await plane.reconcile([pet]);
  await runtime.stopContainer("household.work.sibling");
  await rm(folder, { recursive: true });
  runtime.specs.length = 0;
  await plane.reconcile([pet]);
  expect(runtime.specs).toHaveLength(1);
  expect(runtime.specs[0]!.mounts!.some((mount) => mount.target === "/volumes/nas")).toBe(false);
});

test("native additional directories name only configured guest shares; absent shares are not mounted", async () => {
  const { plane, runtime } = setup();
  const folder = await (await import("node:fs/promises")).realpath(tempDir());
  const contexts: import("../../src/core/agent").PetContext[] = [];
  const adapter = { ...agent, env: (context: import("../../src/core/agent").PetContext) => { contexts.push(context); return agent.env(context); } };
  await plane.reconcile([{ ...pets[0]!, agent: adapter, volumes: [{ name: "server", path: folder, access: "read" }, { name: "missing", path: `${folder}/missing`, access: "write" }] }]);
  expect(contexts[0]!.additionalDirectories).toEqual(["/volumes/server", "/volumes/missing"]);
  expect(runtime.specs[0]!.mounts).toContainEqual({ type: "bind", source: folder, target: "/volumes/server", readOnly: true });
  expect(JSON.stringify(contexts[0]!.additionalDirectories)).not.toContain(folder);
});
