import { GoogleConnectors } from "./google-connectors";
import { googleConnectorTools } from "./google-connector-tools";
import { googleConnectorRoutes } from "./google-connector-routes";
import { HouseInboxes } from "./house-inboxes";
import type { LiveNotice } from "./chat";
import { askRedactedDialog, redactAgentEvent } from "./scout-redaction";
import { ScoutSecretRequests } from "./scout-secrets";
import { SCOUT_TOOLS, Scouts, scoutTools } from "./scouts";
import { ScoutStorage } from "../infra/scout-storage";
import { ScoutArtifacts } from "../infra/scout-artifacts";
import { Capabilities, capabilityTools } from "./capabilities";
import { CapabilityTests } from "./capability-test";
import { scoutsBlock, scoutNetwork } from "../core/scouts";
import { scoutRoutes } from "./scout-routes";
import { scoutSubjects } from "./agents";
import { houseFeatures } from "../core/house-features";
import { writeFile } from "node:fs/promises";
import { Previews, previewTools } from "./previews";
import { PreviewGateway } from "../infra/preview-gateway";
import { petContainer } from "./pet-plane";
import { SecretRequests, secretRequestTool } from "./secret-requests";
import { houseSecrets } from "../core/secrets";
import { PetOutboxFiles } from "../infra/pet-outbox";
import { outboxTool } from "./outbox";
import { HouseMessages, houseMessageTools } from "./house-messages";
import { Sideworkers, sideworkerFinished, sideworkerSpawned, sideworkerTools } from "./sideworkers";
import { makeWorktree } from "./sideworker-workspace";
import { Monitoring } from "./monitoring";
import { MetricsStore } from "../infra/metrics-store";
import { PetInstructions } from "../infra/pet-instructions";
import { PetInboxFiles } from "../infra/pet-inbox";
import { AttachmentFetcher, sweepInboxes } from "./attachments";
import { homesDirectory } from "./runtime-services";
import { householdTimezone } from "../core/timezone";
import { inboxTools } from "./inbox-tools";
import type { InboxEventStore } from "../infra/inbox-event-store";
import { PetMemory } from "./memory";
import type { MemoryStore } from "../infra/memory-store";
import { Crons } from "./crons";
import type { CronStore } from "../infra/cron-store";
import { PetSkills, HouseSkills, houseSkillsRoot, PERSONAL_SKILLS } from "../infra/house-skills";
import { petEnvironment } from "./environment";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { channelKey, channelName, parsePlaceKey } from "../core/channels";
import type { Clock } from "../core/clock";
import { Lifecycles } from "./lifecycle";
import { HouseholdError } from "../core/errors";
import { petDisplay, type House, type Household } from "../core/household";
import { ENVIRONMENT_SETUP_RECOVERY_PROMPT } from "../core/instructions";
import { sameEndpoint, type Endpoint } from "../core/network-policy";
import { ConfigStore } from "../infra/config-store";
import { serveAgentApi } from "../infra/agent-api";
import { serveControl } from "../infra/control-socket";
import { EventLog } from "../infra/event-log";
import { HistoryRunner } from "../infra/history-runner";
import type { HistorySearch } from "../infra/history-store";
import type { Paths } from "../infra/paths";
import { ownAddresses, screenHost, systemResolve, type Resolve } from "../infra/public-resolve";
import { SqliteStore, type ChatIds, type ChatRecords, type KeyValueStore, type MessageStore, type SessionStore } from "../infra/sqlite-store";
import { buildWebBundle, readWebBundle } from "../infra/web-bundle";
import { serveWeb, type WebAssets } from "../infra/web-server";
import { AgentModels } from "./agent-models";
import { agentRoutes } from "./agent-routes";
import { knownAgents, placePets, type Agents, type PlacedPet } from "./agents";
import { openChannels } from "./channels";
import { channelChecks, type ChannelChecks } from "./channel-fields";
import { SubscriptionKeys } from "./subscription-keys";
import { assertOwners, configCheck, knownChannelKinds, knownPlatforms } from "./kinds";
import { Chat, type OpenChannels } from "./chat";
import { Delivery } from "./delivery";
import { Dialogs } from "./dialogs";
import { History, HISTORY_LIMITS } from "./history";
import type { AgentApiAccess, SubjectSpec } from "./gateway";
import { HostNetworkPlane } from "./host-network-plane";
import { KeyAllowances } from "./key-allowances";
import { runtimeServices } from "./runtime-services";
import { NetworkRequests } from "./network-requests";
import { PetPlane, type PetStatus } from "./pet-plane";
import { REPO_ROOT, VERSION } from "./version";
import { COMPILED, releaseShare } from "../infra/release";
import { WebAuth } from "./web-auth";
import { webRoutes, type ApiHandler } from "./web-routes";
import { readPetLog } from "./pet-logs";
import { backUpBeforeMigrating, migrateHousehold } from "./migrations";

export interface DaemonDeps {
  paths: Paths;
  config: ConfigStore;
  agents: Agents;
  network: Pick<HostNetworkPlane, "reconcile" | "reset" | "stop">;
  pets: PetPlane;
  events: EventLog;
  messages: MessageStore;
  crons?: CronStore;
  memory?: MemoryStore;
  inboxEvents?: InboxEventStore;
  /** The houses' chats under Household's message ids, and where each pet was last written to. */
  records: ChatRecords & ChatIds & KeyValueStore;
  /** Where the pets' history searches run, off the daemon's connection. */
  history: HistorySearch;
  openChannels: OpenChannels;
  /** What checks the channel kinds' fields a form gives (a bot token: its shape, with Telegram). */
  channelChecks: ChannelChecks;
  /** The web UI's signed-in browsers. */
  sessions: SessionStore;
  /** The web UI's files, built at the start. A failure leaves the UI off, nothing else. */
  webAssets: () => Promise<WebAssets>;
  /** Injectable wall clock for temporary network grants. */
  networkClock?: Clock;
  /** Injectable clock for scheduled pet restarts. */
  lifecycleClock?: Clock;
  /** How a domain a pet asks for is resolved before its owner is asked; tests stub it. */
  networkResolve?: Resolve;
}

/** The agent API's port when the config's `daemon.agentPort` is not set. */
export const DEFAULT_AGENT_PORT = 7341;

/** The web UI's port when the config's `daemon.webPort` is not set. */
export const DEFAULT_WEB_PORT = 8780;

/** The web UI's entry, bundled at the start. */
const WEB_ENTRY = join(REPO_ROOT, "web", "index.html");

/** A web API call from the CLI over the control socket, and its answer (the HTTP status and the JSON body). */
export interface ApiCall {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}
export interface ApiAnswer {
  status: number;
  body: unknown;
}

export interface SendRequest {
  house: string;
  pet: string;
  text: string;
}

/** The web UI: where it listens, or why it is off. */
export type WebStatus = { url: string } | { off: string };

export interface StatusReport {
  state: "starting" | "running";
  subjects: SubjectSpec[];
  pets: PetStatus[];
  /** None until the start gets to it. */
  web?: WebStatus;
}

/** `house dashboard`'s answer: the sign-in link, good once for a minute, or why the UI is off. */
export type DashboardLink = WebStatus;

/** A reload's answer: the state after it, and the channels it could not open (why, one line each). */
export interface ReloadReport extends StatusReport {
  warnings: string[];
}

/**
 * A house as a network subject: its own allowlist plus the hosts its pets' keys go to (which are thereby
 * reachable, and intercepted to fill each pet's key in).
 */
export function houseSubject(house: House, pets: PlacedPet[]): SubjectSpec {
  const intercept: Endpoint[] = [];
  const allow = [...house.network.allow];
  for (const pet of pets.filter((each) => each.house === house.name && !each.scout)) {
    for (const { target } of pet.keyUse.wire) {
      if (!intercept.some((host) => sameEndpoint(host, target))) intercept.push(target);
      if (!allow.some((entry) => sameEndpoint(entry, target))) allow.push(target);
    }
    for (const target of (pet.secrets ?? []).flatMap(({ hosts }) => hosts)) if (!intercept.some((host) => sameEndpoint(host, target))) intercept.push(target);
  }
  // An owner secret selects substitution targets, never grants network access.
  return { subject: { kind: "house", name: house.name }, policy: { kind: "allowlist", allow }, intercept };
}

export async function startDaemon(deps: DaemonDeps) {
  const { paths, config, agents, network, pets, events, messages, records, history, openChannels } = deps;
  // The database's schema migrated when it opened; the config's and the records' go here, in their order.
  await migrateHousehold({ config, records, log: (text) => events.info(text) });
  let state: StatusReport["state"] = "starting";
  let timezone = householdTimezone();
  let placed: PlacedPet[] = [];
  let monitoring: Monitoring | undefined;
  const sideworkers = new Sideworkers({
    otherAllocations: house => scouts.allocations(house),
    store: records, agents, place: (house, pet, place) => chat.spawnPlace(house, pet, place), prepareClosedNotice: (house, name) => chat.prepareSideworkerCloseNotice(house, name, "Sideworker", true),
    // In its parent's place: it was spawned, with a button to its own thread; once closed, that it is finished.
    announce: worker => chat.announce(worker.house, worker.parent, sideworkerSpawned(worker), worker.placement === "same" ? undefined : worker.name, worker.originPlace),
    finished: (worker, notice) => chat.rewrite(worker.house, notice, sideworkerFinished(worker)),
    configured: () => config.load(), reload: () => applyConfig(),
    ensurePlace: (house, pet) => chat.ensurePlace(house, pet),
    resolveDirectory: async (house, pet, cwd) => {
      const current = placed.find(item => item.house === house && item.pet === pet);
      if (!current) return;
      const result = await pets.exec(house, pet)(["realpath", "-e", "--", cwd]);
      const path = result.output.trim(), home = current.agent.home;
      if (!result.ok || /[\x00-\x1f]/.test(path) || !(path === home || path.startsWith(`${home}/`))) return;
      return (await pets.exec(house, pet)(["test", "-d", path])).ok ? path : undefined;
    },
    // In the parent's VM, as its user: the repository's hooks and filters never run on the host. A big checkout takes time.
    makeWorktree: (house, parent, cwd, name) => makeWorktree(pets.exec(house, parent, 120_000), cwd, name),
    ready: async (house, pet) => {
      const current = placed.find(item => item.house === house && item.pet === pet);
      return !!current && (await current.agent.isReady(pets.exec(house, pet), current.mode)).ready;
    },
    dispatch: (caller, to, task) => houseMessages.send(caller, to, task),
    isIdle: async (house, pet) => {
      const current = placed.find(item => item.house === house && item.pet === pet && item.enabled !== false);
      return current?.agent.isIdle ? current.agent.isIdle(pets.exec(house, pet)) : false;
    },
    send: (house, pet, text) => { delivery.send(house, pet, { origin: "internal", text }); },
    log: text => events.info(text),
  });
  const memory = deps.memory ? new PetMemory(deps.memory, (house, pet) => placed.some(item => item.house === house && item.pet === pet), (house, pet) => sideworkers.memoryOwner(house, pet)) : undefined;
  const inboxes = new PetInboxFiles(homesDirectory(paths));
  // Delivery reports to the chat, the chat queues through Delivery; the report only comes once both exist.
  const delivery = new Delivery(
    events,
    (house, pet) => pets.exec(house, pet),
    messages,
    (update) => {
      scouts.activity(update);
      chat.onDelivery(update);
      if (update.kind === "delivered" && update.messages.some(message => message.origin === "chat")) sideworkers.humanMessage(update.house, update.pet);
    },
    (house, pet, dialog, signal) => askRedactedDialog(dialog, text => scouts.redact(house, pet, text), shown => chat.ask(house, pet, shown, signal)),
    undefined, undefined, deps.crons ? () => timezone : undefined,
    // Core memory, then the house's scouts: each part's revision in one, so a change to either sends both again.
    (house, pet) => {
      if (scouts.isScout({house,pet})) return {revision:0,text:""};
      const notes = memory?.context(house,pet);
      // Only pets call scouts: a sideworker gets its memory without them.
      const list = sideworkers.worker(house, pet) ? "" : scoutsBlock(appliedHousehold?.houses.find(each => each.name === house) ?? {});
      return { revision: `${notes?.revision ?? "-"}:${Bun.hash(list)}`, text: (notes?.text ?? "") + list };
    },
    new AttachmentFetcher((house, place, attachment, signal) => chat.download(house, place, attachment, signal), inboxes, events, () => timezone),
    (house, pet, event) => redactAgentEvent(event, text => scouts.redact(house, pet, text)),
  );
  const chat = new Chat(delivery, openChannels, events, new Dialogs(events), records);
  const houseMessages = new HouseMessages(house => {
    const configured = appliedHousehold?.houses.find(item => item.name === house);
    return configured?.pets.filter(pet=>!pet.scout).map(pet => ({ name: pet.name, title: petDisplay(pet), parent: pet.sideworker?.parent, enabled: pet.enabled })) ?? [];
  }, delivery, (house, from, to, text) => chat.peerMessage(house, from, to, text));
  const scoutStorage = new ScoutStorage(paths.stateDir);
  const scoutArtifacts = new ScoutArtifacts(paths.stateDir, scoutStorage, (run,text)=>scouts.redact(run.house,run.id,text));
  const scoutPostedFiles = new Set<string>();
  const scouts = new Scouts({
    otherAllocations: house => sideworkers.allocations(house),
    store: records, configured: () => config.load(),
    place: (house,pet,place)=>chat.spawnPlace(house,pet,place),
    channel: (house,pet)=>chat.targetChannel(house,pet),
    choose: (caller,card,signal,channel,origin)=>chat.ownerCard(caller.house,caller.pet,card,signal,channel,origin),
    values: async run => {
      const current=await config.load();
      return scoutStorage.vmValues(run.house,run.definition,run.capabilities,current.secrets);
    },
    prepare: async (run,values)=>{
      const current=await config.load();
      const material=await scoutStorage.prepare(run.house,run.id,run.definition,{capabilities:run.capabilities,values,ownedSecrets:current.secrets,sharedSkills:await new HouseSkills(houseSkillsRoot(paths.stateDir)).ensure(run.house)});
      const network=scoutNetwork(run.definition,run.capabilities);
      return {...material,capabilities:run.capabilities.map(capability=>capability.name),definition:run.scout,parent:run.parent,network:{kind:"allowlist",allow:[...network.allow,...(network.open?[{host:"*",port:"*" as const,reach:"public" as const}]:[])]},instructions:run.definition.instructions};
    },
    launch: ()=>applyConfig(),
    ready: async run=>{const p=placed.find(p=>p.house===run.house&&p.pet===run.id);return !!p&&(await p.agent.isReady(pets.exec(run.house,run.id),p.mode)).ready;},
    isIdle: async (house,id)=>{const p=placed.find(p=>p.house===house&&p.pet===id);return p?.agent.isIdle?p.agent.isIdle(pets.exec(house,id)):false;},
    remove: run=>scoutStorage.deleteRun(run.house,run.id),
    closedNotice: run=>chat.prepareSideworkerCloseNotice(run.house,run.id,"Scout"),
    notice: (run,text)=>chat.notice(run.house,run.id,scouts.redact(run.house,run.id,text)),
    status: async (run,text,handle)=>{
      const shown=scouts.redact(run.house,run.id,text);
      if(handle){await chat.editLiveNotice(handle as LiveNotice,shown);return handle;}
      return chat.liveNotice(run.house,run.id,shown);
    },
    send: (house,pet,text)=>{delivery.send(house,pet,{origin:"internal",text});},
    rewrite: (run,notice,text,link)=>chat.rewrite(run.house,notice,scouts.redact(run.house,run.id,text),link && run.placement !== "same" ? run.id : undefined),
    // An ended run is no pet of the config any more: its thread is found as its pet's.
    canRemoveThread: run=>{
      const origin=run.channel??parsePlaceKey(run.announcement?.place)?.channel;
      return !!origin && chat.canRemovePlaces(run.house,run.parent,origin);
    },
    removeThread: run=>{
      const origin=run.channel??parsePlaceKey(run.announcement?.place)?.channel;
      if(!origin) throw new Error("The scout’s original channel is unknown; its thread was not deleted");
      return chat.removePlaces(run.house,run.parent,run.id,origin);
    },
    secret: async (run,key,value)=>{await scoutStorage.giveSecret(run.house,run.id,key,value);},
    collect: async (run,files)=>{const result=await scoutArtifacts.collect(run,files);for(const file of await scoutArtifacts.ownerFiles(run,result.map(f=>f.id))){const key=`${run.id}/${file.id}`;if(scoutPostedFiles.has(key))continue;await chat.sendAttachment(run.house,run.id,{kind:"document",name:file.name,bytes:file.bytes});scoutPostedFiles.add(key);}return result;},
    file: (run,name)=>scoutArtifacts.file(run,name),
    passFiles: (run,files)=>scoutArtifacts.pass(run,files,inboxes,placed.find(p=>p.house===run.house&&p.pet===run.parent)?.agent.home??"/home/agent"),
    title: (house,pet)=>{const found=appliedHousehold?.houses.find(h=>h.name===house)?.pets.find(p=>p.name===pet);return found?petDisplay(found):pet;},
    fileNames: async (run,ids)=>Object.fromEntries((await scoutArtifacts.list(run)).filter(f=>ids.includes(f.id)).map(f=>[f.id,f.name])),
    setupProgress: async run=>{
      // Its VM answers once booted; the setup log fills as its capabilities install.
      const log=await pets.exec(run.house,run.id,3_000)(["bash","-lc","test -d ~/environment && { tail -n 5 ~/environment/setup.log 2>/dev/null || true; }"]).catch(()=>undefined);
      if(!log?.ok)return undefined;
      return log.output.split("\n").map(line=>line.trim()).filter(Boolean).at(-1)??"";
    },
    setupFailure: async run=>{
      const result=pets.environmentSetupResult(run.house,run.id);
      if(result?.status!=="failed")return undefined;
      const log=await pets.exec(run.house,run.id,20_000)(["bash","-lc","tail -n 40 ~/environment/setup.log 2>/dev/null"]).catch(()=>undefined);
      return `Setup failed. Last lines:\n${(log?.output??"").slice(-3000)}`;
    },
    log: text=>events.info(text),
  });
  const capabilities = new Capabilities(config, records, () => applyConfig());
  const capabilityTests = new CapabilityTests({store:records,launch:async(house,capability)=>{const r=await scouts.launchProbe(house,capability);return {
    result: async()=>{const setup=pets.environmentSetupResult(house,r.id);const log=await pets.exec(house,r.id,30_000)(["bash","-lc","tail -n 200 ~/environment/setup.log 2>/dev/null"]).catch(()=>undefined);return {ok:setup?.status!=="failed",output:log?.output??""};},
    close:()=>scouts.end(r,"cancelled"),
  };}});
  const histories = new History((house, pet) => chat.conversation(house, pet), records, history);
  const subscriptionKeys = new SubscriptionKeys(paths.gatewaySecretsDir, paths.configFile, (text) => events.error(text));
  // What each subscription key has left, read off the gateway; a used-up key's requests stop there (keys.<k>.allowOverage lets them go on).
  const allowances = new KeyAllowances(records, (text) => events.info(text));
  let appliedHousehold: Household | undefined;
  const googleConnectors = new GoogleConnectors(records);
  const houseInboxes = new HouseInboxes(records, { post: (h, i, e) => chat.postInbox(h, i, e), pet: (h, i, p, e, at) => chat.deliverInbox(h, i, p, e, at) }, undefined, undefined, deps.inboxEvents);
  const crons = deps.crons ? new Crons(deps.crons, delivery,
    (house, pet) => placed.some((item) => item.house === house && item.pet === pet && !item.sideworker && !item.scout),
    (message) => events.info(message), undefined,
    (house, pet) => placed.some(item => item.house === house && item.pet === pet && item.enabled !== false) && !delivery.isSuspended(house, pet)) : undefined;
  let subjects: StatusReport["subjects"] = [];
  const modelCatalog = new AgentModels({
    agents, configured: () => config.load(), applied: () => ({ keys: appliedHousehold?.keys ?? [], pets: placed }),
    exec: (house, pet) => pets.exec(house, pet), cacheFile: join(paths.stateDir, "model-catalog.json"),
    log: (text) => events.error(text),
  });
  const report = async (): Promise<StatusReport> => ({ state, subjects, pets: await pets.status(placed), web: webStatus() });

  // Docker work runs one job at a time: overlapping CLI commands would otherwise race, e.g. both creating
  // the same network. A failed job leaves the previous state in place.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job);
    queue = run.catch(() => {});
    return run;
  };
  // Pets reach the agent API only through the gateway relay, which presents this run's secret.
  const secret = randomBytes(32).toString("hex");
  let access: AgentApiAccess;
  const specsOf = (household: Household, wanted: PlacedPet[]) => [...household.houses.map((house) => {
    const spec = houseSubject(house, wanted);
    return { ...spec, grants: networkRequests.petGrants(house.name).filter(g=>!scouts.isScout({house:house.name,pet:g.pet})) };
  }), ...scoutSubjects(wanted).map(spec=>({...spec,grants:networkRequests.petGrants(spec.subject.name).filter(g=>spec.subject.kind=== "scout" && g.pet===spec.subject.pet)}))];
  const applyNetwork = async (household: Household, wanted: PlacedPet[]) => {
    const staged = await subscriptionKeys.prepare(wanted, household.keys, household.secrets);
    try {
      const result = await network.reconcile(specsOf(household, wanted), staged.credentials, access);
      subjects = result.subjects;
      staged.commit();
      allowances.follow(wanted, household.keys, household.timezone);
    } catch (error) {
      staged.cancel();
      throw error;
    }
  };
  const networkRequests = new NetworkRequests({
    clock: deps.networkClock,
    store: records,
    policy: (house, pet) => {
      const configured = appliedHousehold?.houses.find(({ name }) => name === house);
      const scout=placed.find(p=>p.house===house&&p.pet===pet&&p.scout);
      if(scout)return scoutSubjects([scout])[0]?.policy;
      return configured?.pets.some(({ name }) => name === pet) ? houseSubject(configured, placed).policy : undefined;
    },
    petTitle: (house, pet) => petDisplay(appliedHousehold?.houses.find(({ name }) => name === house)?.pets.find(({ name }) => name === pet) ?? { name: pet }),
    screen: (domain) => screenHost(domain, deps.networkResolve ?? systemResolve, ownAddresses),
    choose: (house, pet, card, signal) => chat.ownerCard(house, pet, card, signal),
    notice: (house, pet, text) => chat.notice(house, pet, text),
    deferScreen: (house,pet)=>!!scouts.run(house,pet),
    // A scout's grants last for its run only: its card has no "forever" (its network is its capabilities').
    permanent: async (house, domain, pet) => { if (pet && scouts.run(house, pet)) throw new Error("A scout's network comes from its capabilities"); await config.grantHost(house, domain); },
    changed: () => enqueue(async () => {
      if (!appliedHousehold) return;
      const latest = await config.load();
      // Only network settings change here: approvals and expiry never restart pets or their dialogs.
      const household = { ...appliedHousehold, houses: appliedHousehold.houses.map((house) => ({
        ...house, network: latest.houses.find(({ name }) => name === house.name)?.network ?? house.network,
      })) };
      await applyNetwork(household, placed);
      appliedHousehold = household;
    }),
  });
  // Secrets affect gateway substitution immediately. Placeholder env vars refresh at the next VM start.
  const applySecrets = () => enqueue(async () => {
    if (!appliedHousehold) throw new HouseholdError("Household is not ready");
    const latest = await config.load();
    const household = { ...appliedHousehold, secrets: latest.secrets };
    const refreshed = placePets(agents, scouts.expanded(sideworkers.expanded(latest)));
    const wanted = placed.map(pet => ({ ...pet, secrets: refreshed.find(p=>p.house===pet.house&&p.pet===pet.pet)?.secrets ?? [] }));
    await applyNetwork(household, wanted);
    appliedHousehold = household;
    placed = wanted;
  });
  const secretRequests = new SecretRequests({
    house: name => appliedHousehold?.houses.find(house => house.name === name),
    secrets: () => appliedHousehold?.secrets ?? [],
    save: async (house, name, value, hosts, env) => {
      await config.addSecret(name, { value, hosts, env, houses: [house] });
      await applySecrets();
    },
    choose: (house, pet, card, signal) => chat.ownerCard(house, pet, card, signal),
    notice: (house, pet, text) => chat.secretNotice(house, pet, text),
    notify: (house, pet, text) => { delivery.send(house, pet, { origin: "internal", text }); },
    log: text => events.info(text),
  });
  const scoutSecretRequests = new ScoutSecretRequests(scouts,(c,text)=>chat.notice(c.house,c.pet,text));
  chat.setSecretRequests({handle:async input=>await scoutSecretRequests.handle(input)||await secretRequests.handle(input)});
  const previewGateway = new PreviewGateway();
  const previews = new Previews({
    house: name => appliedHousehold?.houses.find(h => h.name === name),
    ready: async caller => (await pets.status(placed)).some(p => p.house === caller.house && p.pet === caller.pet && p.state === "running"),
    open: (caller, port, settings, signal) => previewGateway.open({ machine: petContainer(caller.house, caller.pet), port, ...settings, signal }),
    choose: (caller, card, signal) => chat.ownerCard(caller.house, caller.pet, card, signal),
    notify: (caller, text) => { delivery.send(caller.house, caller.pet, { origin: "internal", text }); },
    log: (caller, text) => events.info(`bot ${caller.house}/${caller.pet}: preview ${text}`),
  });
  pets.onBeforeStop((house, pet) => previews.closePet({ house, pet }));
  const lifecycleTitle = (house: string, pet: string) => petDisplay(appliedHousehold?.houses.find(item => item.name === house)?.pets.find(item => item.name === pet) ?? { name: pet });
  const announceStopped = async ({ house, pet }: { house: string; pet: string }) => {
    events.info(`bot ${house}/${pet} stopped`);
    await chat.notice(house, pet, `${lifecycleTitle(house, pet)} stopped.`);
  };
  const announceStarted = async (started: PlacedPet[]) => {
    const results = await pets.awaitReady(started);
    for (const start of results) {
      const name = `bot ${start.house}/${start.pet}`;
      if (start.ready) events.info(`${name} started`);
      if (start.warning) events.error(`${name}: ${start.warning}`);
      else if (!start.ready) events.error(`${name} started but is not ready; it shows: ${compact(start.output ?? "")}`);
      const title = lifecycleTitle(start.house, start.pet);
      await chat.notice(start.house, start.pet, start.ready ? `${title} started.` : `${title}: the VM is up, but the agent is not responding. \`house pet attach\``);
      const parent = sideworkers.worker(start.house, start.pet)?.parent;
      const setupResult = pets.environmentSetupResult(start.house, start.pet);
      if (start.ready && setupResult?.status === "failed" && setupResult.attempted !== false) {
        delivery.send(start.house, start.pet, { origin: parent ? "internal" : "cli", text: parent ? `Household: Your inherited setup script failed. Inspect ~/environment/setup.log as diagnostic data. Ask parent ${parent} through house_send to repair the shared script, then call environment_setup to retry. Do not retry unchanged failures indefinitely.` : ENVIRONMENT_SETUP_RECOVERY_PROMPT });
        void chat.notice(start.house, start.pet, "The setup script failed. The agent will look into it and run it again.");
      }
      if (start.ready && pets.environmentSetupResult(start.house, start.pet, "onStart")?.status === "failed") {
        void chat.notice(start.house, start.pet, "The on-start script failed. The agent will look into it.");
        delivery.send(start.house, start.pet, { origin: parent ? "internal" : "cli", text: parent ? `Household: Your inherited on-start script failed. Inspect ~/environment/on-start.log as diagnostic data. Ask parent ${parent} through house_send to repair the shared script, then call environment_on_start to retry. Do not retry unchanged failures indefinitely.` : "Household: On start failed. Inspect ~/environment/on-start.log and on-start.status as diagnostic data. Use environment_get and environment_update({onStart}) to repair, then environment_on_start to retry. Do not retry unchanged failures indefinitely. Your agent is still running." });
      }
    }
    return results;
  };
  config.resourceAllocations = house => [...sideworkers.allocations(house), ...scouts.allocations(house)];
  /** `loaded`: the config at the start. Resolves to the channels that could not open, one line each. */
  const reload = (loaded?: Household) =>
    enqueue(async () => {
      const household = scouts.expanded(sideworkers.expanded(loaded ?? (await config.load())));
      const { houses } = household;
      const wanted = placePets(agents, household); // before any docker work: an unknown agent or key changes nothing
      assertOwners(houses); // nor an owner id typed wrong
      for (const pet of wanted) if (pet.enabled === false) await delivery.suspend(pet.house, pet.pet);
      // A pet gone from the config keeps no grant: the network applied next has none of its.
      networkRequests.setPets(wanted);
      secretRequests.setPets(wanted);
      googleConnectors.setHouses(houses);
      await previews.reconcile(houses);
      await applyNetwork(household, wanted);
      timezone = householdTimezone(household.timezone);
      crons?.setTimezone(timezone);
      appliedHousehold = household;
      events.info(`reconciled: ${subjects.map((s) => s.subject.name).join(", ") || "no workspaces"}`);
      placed = wanted;
      // Back to back: a channel's first message must find its pet's mailbox, and the mailboxes' notices the channel.
      await chat.setHouses(houses);
      scouts.opened(); // a starting scout's thread exists now: its card goes up before its VM boots
      delivery.setPets(wanted);
      const warnings = houses.flatMap((house) =>
        house.channels.flatMap((channel) => {
          const problem = chat.problem(house.name, channelKey(channel));
          return problem === undefined ? [] : [`workspace ${house.name}, channel ${channelName(knownChannelKinds(), channel)}: ${problem}`];
        }),
      );
      const { started, removed } = await pets.reconcile(wanted, announceStopped);
      for (const pet of started) delivery.restarted(pet.house, pet.pet); // before anything reaches the new session
      for (const name of removed) events.info(`removed ${name}: no longer in the config (its home volume stays)`);
      await delivery.adopt(wanted.filter((pet) => pet.enabled !== false && !started.includes(pet)));
      const recovering = wanted.filter((pet) => pet.enabled !== false && !started.includes(pet) && delivery.isSuspended(pet.house, pet.pet));
      const ready = [...await announceStarted(started), ...await pets.awaitReady(recovering)];
      for (const pet of wanted) {
        if (pet.enabled === false) continue;
        if (!delivery.isSuspended(pet.house, pet.pet) || ready.some((start) => start.house === pet.house && start.pet === pet.pet && start.ready)) delivery.resume(pet.house, pet.pet);
      }
      houseInboxes.setHouses(houses);
      return warnings;
    });
  /** A reload asked for (CLI, web UI): one that fails is logged. */
  const applyConfig = async (): Promise<string[]> => {
    try {
      return await reload();
    } catch (error) {
      events.error(`reload failed: ${(error as Error).message}`);
      throw error;
    }
  };
  const auth = new WebAuth(deps.sessions);
  let web: ReturnType<typeof serveWeb> | undefined;
  /** Why the web UI is off. */
  let webOff: string | undefined;
  const webStatus = (): WebStatus | undefined => (web ? { url: `http://127.0.0.1:${web.port}` } : webOff === undefined ? undefined : { off: webOff });
  const environment = petEnvironment(config, pets, enqueue, (house, pet) => placed.some((item) => item.house === house && item.pet === pet && item.enabled !== false), async (house, pet, setup, onStart) => {
    const current = placed.find((item) => item.house === house && item.pet === pet)!;
    const wanted = { ...current, environment: { setup, onStart } };
    try {
      await pets.restart(wanted, async () => {
        await delivery.suspend(house, pet);
      }, () => announceStopped({ house, pet }));
      const [start] = await announceStarted([wanted]);
      if (!start?.ready) throw new Error("bot VM restarted but the harness is not ready");
      delivery.resume(house, pet);
    } catch (error) {
      events.error(`bot ${house}/${pet} VM restart failed: ${(error as Error).message}`);
      throw error;
    }
  }, (house, pet, action, notice) => delivery.prepareRestart(house, pet, notice?.timeoutMs, action, notice?.text), async (house, pet) => {
    await config.updatePet(house, pet, { enabled: false });
    await applyConfig();
    events.info(`bot ${house}/${pet}: disabled`);
  }, (house, pet) => sideworkers.memoryOwner(house, pet));

  /** The web UI, or why it is off: never a reason for the daemon (and the pets) not to run. */
  /** The web API as the CLI calls it over the control socket; set when the web routes are. */
  let localApi: ApiHandler | undefined;
  async function startWeb(port: number): Promise<void> {
    let assets: WebAssets;
    try {
      const handle = webRoutes({
        resourceAllocations: house => [...sideworkers.allocations(house), ...scouts.allocations(house)],
        connectorRoutes: googleConnectorRoutes(googleConnectors),
        scoutRoutes: scoutRoutes({config,storage:scoutStorage,scouts,capabilities,tests:capabilityTests,apply:applyConfig,applySecrets,
          vm:{log:async(house,id,source,read)=>placed.some(p=>p.house===house&&p.pet===id)?readPetLog(pets.exec(house,id),source,read):undefined,
            screen:async(house,id)=>{const current=placed.find(p=>p.house===house&&p.pet===id);return current?pets.terminalSnapshot(current):undefined;}}}),
        auth,
        monitoring,
        sideworkers,
        previews,
        crons,
        houseInboxes,
        memory,
        instructions: new PetInstructions(homesDirectory(paths)),
        skills: new HouseSkills(houseSkillsRoot(paths.stateDir)),
        petSkills: new PetSkills(homesDirectory(paths)),
        // An agent lists its skills when its session starts: one made since is announced, so it is not missed.
        skillAdded: (house, pet, name) => {
          for (const each of placed.filter((item) => item.house === house && item.enabled !== false && (pet === undefined ? true : item.pet === pet))) {
            const where = pet === undefined ? `the house's shared skill ${name}, at /opt/household/skills/${name}/SKILL.md` : each.sideworker ? `the project skill ${name} in your working directory` : `your personal skill ${name}, at ~/${PERSONAL_SKILLS}/${name}/SKILL.md`;
            delivery.send(house, each.pet, { origin: "internal", text: `Household: your human added ${where}. Your list of skills may show it only from your next session: read its SKILL.md when it applies. This is a notice, not a task.` });
          }
        },
        config,
        agents,
        channelKinds: knownChannelKinds(),
        checks: deps.channelChecks,
        platforms: knownPlatforms(),
        apply: applyConfig,
        applySecrets,
        petStates: () => pets.status(placed),
        allowances: (key) => allowances.of(key),
        terminalSnapshot: async (house, pet, agent) => {
          const current = placed.find((item) => item.house === house && item.pet === pet && item.agent.name === agent);
          return current ? pets.terminalSnapshot(current) : undefined;
        },
        channelProblem: (house, key) => chat.problem(house, key),
        state: () => state,
        version: VERSION,
        events,
        networkRequests,
        modelCatalog,
        environment,
        eventLog: paths.eventLog,
        petLog: async (house, pet, source, read) => {
          const current = placed.find((item) => item.house === house && item.pet === pet && item.enabled !== false);
          return current ? readPetLog(pets.exec(house, pet), source, read) : undefined;
        },
      });
      localApi = handle;
      assets = await deps.webAssets();
      web = serveWeb({ port, assets, handle });
    } catch (error) {
      const taken = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      webOff = taken ? `port ${port} is taken: set daemon.webPort in the config, then restart` : (error as Error).message;
      return events.error(`web UI off: ${webOff}`);
    }
    events.info(`web UI on http://127.0.0.1:${web.port}: sign in with \`house dashboard\``);
  }

  // The socket comes first: it is the single-instance guard, so a second daemon fails here before
  // touching the gateway, and it answers `status` (and queues reloads) while the gateway is built.
  const control = await serveControl(paths.socket, {
    "/status": report,
    "/send": async (body) => {
      const { house, pet, text } = (body ?? {}) as Partial<SendRequest>;
      if (!house || !pet || !text) throw new HouseholdError("send needs workspace, bot and text");
      return delivery.send(house, pet, { text, origin: "cli" });
    },
    "/reload": async (): Promise<ReloadReport> => {
      const warnings = await applyConfig();
      return { ...(await report()), warnings };
    },
    /** The web UI's API for the CLI: the same routes, checks and answers (`house pet restart`, `house logs`, …). */
    "/api": async (body): Promise<ApiAnswer> => {
      const { method, path, body: payload } = (body ?? {}) as Partial<ApiCall>;
      if (!method || !path?.startsWith("/api/")) throw new HouseholdError("api needs a method and an /api/ path");
      if (!localApi) throw new HouseholdError("the daemon is still starting: try again in a moment");
      const response = await localApi.local(new Request(`http://household${path}`, {
        method,
        ...(payload === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
      }));
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    /** A one-time sign-in link for the web UI (`house dashboard`). */
    "/dashboard": async (): Promise<DashboardLink> => {
      if (web) return { url: `http://127.0.0.1:${web.port}/login?token=${auth.mintToken()}` };
      if (webOff !== undefined) return { off: webOff };
      throw new HouseholdError("the web UI is not up yet: try again in a moment");
    },
  });
  let agentApi: ReturnType<typeof serveAgentApi> | undefined;
  events.info("starting: host proxy and isolated bot VMs");
  try {
    // The first job, so a reload that comes in meanwhile waits for the agent API and the fresh gateway image.
    const initial = await enqueue(async () => {
      const loaded = await config.load();
      const port = loaded.daemon.agentPort ?? DEFAULT_AGENT_PORT;
      agentApi = serveAgentApi({ port, secret, handle: agentRoutes(delivery, chat, histories, {list:(h,p)=>networkRequests.list(h,p),request:async(h,p,d,r,port,signal)=>{scouts.accessFact(h,p,d,"pending");const result=await networkRequests.request(h,p,d,r,port,signal);scouts.accessFact(h,p,d,result.status);return result;}}, environment, crons, memory, [...googleConnectorTools(googleConnectors), ...inboxTools(deps.inboxEvents, houseInboxes, c => !!appliedHousehold?.houses.some(h => h.name === c.house && h.pets.some(p => p.name === c.pet && !p.scout && !p.sideworker))), scoutSecretRequests.tool(), ...capabilityTools(capabilities,(house,secret)=>appliedHousehold?.secrets.find(item=>item.name===secret)?.env,c=>!scouts.isScout(c)&&!!appliedHousehold?.houses.some(h=>h.name===c.house&&houseFeatures(h).scouts&&h.pets.some(p=>p.name===c.pet&&!p.scout&&!p.sideworker))),...scoutTools(scouts,c=>!!appliedHousehold?.houses.some(h=>h.name===c.house&&houseFeatures(h).scouts&&h.pets.some(p=>p.name===c.pet&&!p.scout&&!p.sideworker))), ...previewTools(previews), { ...secretRequestTool(secretRequests), available: c => !scouts.isScout(c) }, ...sideworkerTools(sideworkers), ...houseMessageTools(houseMessages), outboxTool(new PetOutboxFiles(homesDirectory(paths)), chat, events, (house,pet)=>{
        // A scout's home is in its run's storage, not among the pets' homes.
        const home=placed.find(p=>p.house===house&&p.pet===pet)?.scout?.homePath;
        return home?{files:new PetOutboxFiles(dirname(home)),volume:basename(home)}:undefined;
      })], caller => !!sideworkers.worker(caller.house, caller.pet) || scouts.isScout(caller), {allow:(c,name)=>!scouts.isScout(c)||SCOUT_TOOLS.includes(name),redact:(c,payload)=>scouts.redactPayload(c,payload),replied:(c,text)=>scouts.recordReply(c,text)}) });
      access = { url: `http://127.0.0.1:${agentApi.port}`, secret };
      try {
        monitoring = new Monitoring(new MetricsStore(join(paths.stateDir, "metrics.db")), () => pets.monitoringStates(placed),
          (house, pet, command) => pets.exec(house, pet)(command));
      } catch { events.error("Monitoring unavailable: could not open metrics database"); }
      await startWeb(loaded.daemon.webPort ?? DEFAULT_WEB_PORT);
      await network.reset((entry) => {
        if(entry.subject?.kind==="scout"){scouts.networkFact(entry.subject.name,entry.pet!,entry.target,entry.kind==="connect"?entry.verdict:String(entry.status));events.append({type:"proxy",...entry,target:"[scout network activity]",reason:undefined});}
        else events.append({ type: "proxy", ...entry });
      }, { guard: (pet, target) => allowances.guard(pet, target), observe: (pet, target, headers) => allowances.observe(pet, target, headers) });
      return loaded;
    });
    await networkRequests.start();
    await reload(initial);
  } catch (error) {
    await monitoring?.stop();
    await networkRequests.stop();
    await secretRequests.stop();
    await previews.stop();
    subscriptionKeys.stop();
    await network.stop();
    await chat.stop();
    await agentApi?.stop();
    await web?.stop();
    await control.stop();
    throw error;
  }
  // Scheduled restarts run with the scheduler (production), never in a daemon without one.
  const lifecycles = deps.crons ? new Lifecycles({
    pets: () => (appliedHousehold?.houses ?? []).flatMap((house) => house.pets
      .filter((pet) => pet.lifecycle?.enabled && pet.enabled !== false && !pet.sideworker && !pet.scout)
      .map((pet) => ({ house: house.name, pet: pet.name, lifecycle: pet.lifecycle! }))),
    timezone: () => timezone,
    restart: (house, pet, notice) => environment.restartEnvironment(house, pet, "notify", notice),
    wakeUp: (house, pet, text) => { delivery.send(house, pet, { origin: "cli", text }); },
    log: (message) => events.info(message),
    error: (message) => events.error(message),
    ...(deps.lifecycleClock ? { clock: deps.lifecycleClock } : {}),
  }) : undefined;
  sideworkers.start();
  scouts.start();
  monitoring?.start();
  crons?.start();
  houseInboxes.start();
  lifecycles?.start();
  const stopSweeping = sweepInboxes(inboxes, events);
  state = "running";
  events.info(`ready, control socket ${paths.socket}`);

  return {
    /** Stops the daemon and the gateway. Pets keep running, without network until the next start. */
    async stop() {
      sideworkers.stop();
      await scouts.stop();
      await monitoring?.stop();
      crons?.stop();
      googleConnectors.stop();
      await houseInboxes.stop();
      lifecycles?.stop();
      stopSweeping();
      await networkRequests.stop();
      await secretRequests.stop();
      await previews.stop();
      const closed = control.stop();
      pets.stopWaiting();
      await queue; // an in-flight reload finishes (and answers) before the gateway goes away
      subscriptionKeys.stop();
      await chat.stop();
      delivery.stop();
      await agentApi?.stop();
      await web?.stop();
      await network.stop();
      await closed;
      events.info("stopped");
    },
  };
}

/** Multi-line output as one log-friendly line. */
function compact(output: string): string {
  return output.split("\n").map((line) => line.trim()).filter(Boolean).join(" | ").slice(0, 400);
}


/**
 * Composition root for `house start`: real dependencies, in the foreground until SIGINT or SIGTERM, also during
 * the start: the docker calls running then are killed, and it exits 0 (a second signal only says it is stopping).
 * For a supervisor, a start that fails throws (exit code 1), and so does a stop that fails.
 */
/** What `house start` runs on: the VM runtime (cancelled on a signal), the egress gateway and the pets' plane. */
export interface DaemonServices {
  runtime: { cancel(): void };
  network: DaemonDeps["network"];
  pets: PetPlane;
}

export async function runDaemon(paths: Paths, services: () => DaemonServices = () => runtimeServices(paths)): Promise<void> {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const events = new EventLog(paths.eventLog, console.log);
  const { runtime, network, pets } = services();
  // Before the database opens (its schema migrates then): what is to be migrated is copied aside first.
  const { dir: backup, report } = backUpBeforeMigrating(paths);
  if (backup) events.info(`to migrate: ${report.pending.map((each) => each.name).join("; ")}; the config and the database are backed up to ${backup}`);
  const store = new SqliteStore(paths.database);
  const history = new HistoryRunner(paths.database, HISTORY_LIMITS.timeoutMs);
  const telegramApi = process.env.HOUSEHOLD_TELEGRAM_API; // a fake Bot API, for the e2e run
  const signalled = Promise.withResolvers<void>();
  let stopping = false;
  const onSignal = (name: string) => {
    if (stopping) return events.info(`${name}: already stopping`);
    stopping = true;
    events.info(`${name}: stopping`);
    runtime.cancel(); // an image build or a pull is not waited for
    pets.stopWaiting();
    signalled.resolve();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  let daemon;
  try {
    daemon = await startDaemon({
      paths,
      config: new ConfigStore(paths.configFile, configCheck(knownAgents())),
      agents: knownAgents(),
      network,
      pets,
      events,
      messages: store,
      crons: store.crons,
      memory: store.memory,
      inboxEvents: store.inboxEvents,
      records: store,
      history,
      openChannels: openChannels({ state: store, events, telegramApi }),
      channelChecks: channelChecks(telegramApi),
      sessions: store,
      webAssets: () => (COMPILED ? readWebBundle(join(releaseShare(), "web")) : buildWebBundle(WEB_ENTRY)),
    });
  } catch (error) {
    history.stop();
    store.close();
    if (!stopping) throw error;
    events.info(`stopped while starting (${(error as Error).message})`);
    process.exit(0);
  }
  await signalled.promise;
  try {
    await daemon.stop();
  } finally {
    history.stop();
    store.close();
  }
  process.exit(0);
}
