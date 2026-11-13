import { CLOCK, type Clock } from "../core/clock";
import { cardText, html } from "../core/card";
import { HouseholdError } from "../core/errors";
import { petDisplay, type House } from "../core/household";
import { carriesHouseholdTag } from "../core/tags";
import { botsTouched, describeFiles, nestingProblem, VOLUME_ACCESS, volumeNameSchema, volumeTarget, type Volume, type VolumeAccess } from "../core/volumes";
import { VOLUME_REQUEST_TOOL } from "../core/instructions";
import type { PetIdentity } from "../infra/agent-api";
import type { McpTool } from "../infra/mcp-server";
import { ensureFolder, inspectFolder, type FolderInfo } from "../infra/volume-folders";
import type { OwnerCard } from "./chat";

type Decision = "waiting" | "approve" | "deny";
type Action = "create" | "update" | "delete";

export interface VolumeRequestOptions {
  /** The house as Household runs it now. */
  house(name: string): House | undefined;
  /** Every workspace's volumes as Household runs them (`name` is the workspace's own). */
  volumes(): (Volume & { house: string })[];
  /** The house as the config has it now: an approval is checked against it before it is written. */
  current(name: string): Promise<House | undefined>;
  /** Host folders no bot may get (infra/volume-folders.ts `protectedFolders`). */
  protectedDirs: readonly string[];
  /** Writes the volume (`undefined`: removes it), refused when it is no longer `expected`. */
  write(house: string, name: string, volume: Volume | undefined, expected: Volume | null): Promise<void>;
  /** The running VMs (the bots and their sideworkers) a change to these bots' mounts restarts. */
  affected(house: string, bots: string[]): Promise<string[]>;
  /** Asks a bot to finish its turn before its VM restarts; the returned function lets delivery go on. */
  prepareRestart(house: string, pet: string, notice: string): Promise<() => void>;
  choose(house: string, pet: string, card: OwnerCard<Decision>, signal: AbortSignal): Promise<Decision | undefined>;
  /** An internal message to a bot (queued: a restarting one gets it in its new session). */
  notify(house: string, pet: string, text: string): void;
  log(text: string): void;
  clock?: Clock;
  waitMs?: number;
}

const WAIT_MS = 10 * 60_000;
const HOUR = 60 * 60_000;
const MAX_REQUESTS = 10;
const accessWord = (access: VolumeAccess) => (access === "write" ? "read-write" : "read-only");
const safeText = (text: string) => text.replace(/[\p{Cc}\p{Cf}<>]/gu, " ");

/** A bot's requests to add, change or remove a volume of its workspace: each one waits for its owner's approval. */
export class VolumeRequests {
  private readonly clock: Clock;
  /** At most one request per house waits for its owner. */
  private readonly pending = new Map<string, { pet: string; controller: AbortController }>();
  private readonly rate = new Map<string, number[]>();
  private readonly tasks = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly options: VolumeRequestOptions) { this.clock = options.clock ?? CLOCK; }

  async request(house: string, pet: string, args: { action?: unknown; name?: unknown; path?: unknown; access?: unknown; bots?: unknown; reason?: unknown }): Promise<Record<string, unknown>> {
    const action = (args.action ?? "create") as Action;
    if (!["create", "update", "delete"].includes(action)) throw new Error("action must be create, update or delete");
    if (!volumeNameSchema.safeParse(args.name).success) throw new Error("name must start with a–z and contain only a–z, 0–9 or hyphens, up to 31 characters");
    const name = args.name as string;
    if (typeof args.reason !== "string" || !args.reason.trim() || args.reason.length > 600 || /[\p{Cc}\p{Cf}]/u.test(args.reason) || carriesHouseholdTag(args.reason))
      throw new Error("reason must be 1–600 characters without control characters or Household tags");
    if (args.access !== undefined && !VOLUME_ACCESS.includes(args.access as VolumeAccess)) throw new Error("access must be read or write");
    if (args.path !== undefined && (typeof args.path !== "string" || args.path.length > 1024)) throw new Error("path must be a host folder: an absolute path or ~/…");
    if (args.bots !== undefined && (!Array.isArray(args.bots) || args.bots.length > 64 || args.bots.some(bot => typeof bot !== "string"))) throw new Error("bots must be a list of bot names");
    if (action === "delete" && [args.path, args.access, args.bots].some(value => value !== undefined)) throw new Error("delete only takes name and reason");
    if (action === "update" && [args.path, args.access, args.bots].every(value => value === undefined)) throw new Error("update needs path, access or bots");
    if (action === "create" && args.path === undefined) throw new Error("create needs path: the host folder to share");

    const configured = this.options.house(house);
    const member = configured?.pets.find(p => p.name === pet && !p.sideworker && !p.scout);
    if (this.stopped || !configured || !member) return { status: "refused", message: "Only a bot of the workspace can ask for its folders." };
    const existing = configured.volumes?.find(volume => volume.name === name);
    if (action === "create" && existing) return { status: "refused", message: `Volume ${name} already exists: use action update to change it.` };
    if (action !== "create" && !existing) return { status: "refused", message: `No volume ${name} in this workspace.` };
    const bots = args.bots === undefined ? (existing?.bots ?? [pet]) : [...new Set(args.bots as string[])];
    const unknown = bots.filter(bot => !configured.pets.some(p => p.name === bot && !p.sideworker && !p.scout));
    if (unknown.length) return { status: "refused", message: `Unknown bots: ${unknown.join(", ")}.` };
    if (this.pending.has(house)) return { status: "busy", message: "This workspace already has a folder request waiting for its owner. Wait for its outcome." };
    const recent = (this.rate.get(house) ?? []).filter(time => time > this.clock.now() - HOUR);
    if (recent.length >= MAX_REQUESTS) return { status: "busy", message: "This workspace has reached its hourly limit of folder requests." };
    // Taken before the first wait (a folder's files take a while to count): parallel calls never get two cards, and a
    // refused request counts toward the hour too.
    recent.push(this.clock.now());
    this.rate.set(house, recent);
    const pending = { pet, controller: new AbortController() };
    this.pending.set(house, pending);
    const refuse = (message: string) => {
      if (this.pending.get(house) === pending) this.pending.delete(house);
      return { status: "refused", message };
    };

    let folder: FolderInfo | undefined;
    const path = args.path === undefined ? existing?.path : args.path as string;
    if (path !== undefined && action !== "delete") {
      try { folder = await inspectFolder(path, this.options.protectedDirs); }
      catch (error) { return refuse(error instanceof HouseholdError ? error.message : "That folder cannot be shared."); }
      if (args.path === undefined && folder.path !== existing!.path) return refuse(`Volume ${name}'s folder is no longer the one that was shared (a part of its path is a link now): your human can share it again.`);
    }
    const after: Volume | undefined = action === "delete" ? undefined : {
      name, path: folder?.path ?? existing!.path, access: (args.access as VolumeAccess | undefined) ?? existing?.access ?? "read", bots,
      ...(existing?.note ? { note: existing.note } : {}),
    };
    if (after) {
      const nested = nestingProblem(after.path, after.access, this.options.volumes().filter(other => !(other.house === house && other.name === name)));
      if (nested) return refuse(nested);
    }
    if (this.stopped) return refuse("Household is stopping.");
    const snapshot = existing ? structuredClone(existing) : null;
    let card: OwnerCard<Decision>;
    try { card = this.card(configured, member.title ?? petDisplay(member), action, args.reason.trim(), snapshot ?? undefined, after, folder); }
    catch { return refuse("The request could not be shown to your human."); }
    const cancelTimer = this.clock.after(this.options.waitMs ?? WAIT_MS, () => pending.controller.abort());
    const task = (async () => {
      try {
        const aborted = new Promise<undefined>(resolve => pending.controller.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
        const decision = await Promise.race([this.options.choose(house, pet, card, pending.controller.signal), aborted]);
        if (decision !== "approve" || pending.controller.signal.aborted || this.stopped) {
          this.notify(house, pet, `Household: your request to ${action} folder ${name} was ${decision === "deny" ? "denied" : "not answered"}. Nothing changed.`);
          this.options.log(`volume request ${decision === "deny" ? "denied" : "expired"}: ${house}/${pet} ${action} ${name}`);
          return;
        }
        cancelTimer();
        await this.apply(house, pet, action, name, after, snapshot);
      } catch (error) {
        this.notify(house, pet, `Household: your folder request (${action} ${name}) could not be applied: ${(error as Error).message}. Nothing changed; your human can check the workspace's Volumes page.`);
        this.options.log(`volume request failed: ${house}/${pet} ${action} ${name}: ${(error as Error).message}`);
      } finally {
        cancelTimer();
        pending.controller.abort();
        if (this.pending.get(house) === pending) this.pending.delete(house);
      }
    })();
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    this.options.log(`volume requested: ${house}/${pet} ${action} ${name}`);
    const restarts = botsTouched(snapshot ? [snapshot] : [], after ? [after] : []).includes(pet);
    return { status: "pending", action, name, restarts_vm_if_approved: restarts, message: restarts
      ? "Your human was asked in the chat. If they approve, your VM restarts and this session ends: save what you need to Household memory now (your home stays). Household tells you the outcome after the restart; a denial changes nothing."
      : "Your human was asked in the chat. This change does not touch your own folders, so your VM does not restart; the bots it touches do. Household tells you the outcome." };
  }

  /** The owner's card: who asks, why, what would change, and what approving does. */
  private card(house: House, who: string, action: Action, reason: string, before: Volume | undefined, after: Volume | undefined, folder?: FolderInfo): OwnerCard<Decision> {
    const title = (bots: string[]) => bots.map(bot => html(house.pets.find(p => p.name === bot) ? petDisplay(house.pets.find(p => p.name === bot)!) : bot)).join(", ") || "none";
    const facts = (volume: Volume, info?: FolderInfo) => [
      `Folder: <code>${html(volume.path)}</code>`,
      ...(info ? [`Holds: ${html(describeFiles(info))}`] : []),
      `Access: ${accessWord(volume.access)}`,
      `Bots: ${title(volume.bots)}`,
      `In their VMs: <code>${volumeTarget(volume.name)}</code>`,
    ];
    const name = (after ?? before)!.name;
    const restarted = botsTouched(before ? [before] : [], after ? [after] : []);
    const warning = folder?.warning ? [`⚠️ ${html(folder.warning)}`] : [];
    const text = cardText({
      title: `${html(safeText(who))} ${action === "create" ? "asks to share a folder" : action === "update" ? `asks to change shared folder ${name}` : `asks to stop sharing folder ${name}`}`,
      quote: { label: "Why", text: reason },
      facts: action === "create" ? [...facts(after!, folder), ...warning]
        : action === "delete" ? facts(before!)
        : [`Before:\n${facts(before!).join("\n")}`, `After:\n${facts(after!, folder).join("\n")}`, ...warning],
      note: [
        action === "delete" ? "Unmounts it; the folder and its files stay on your computer." : folder && !folder.exists ? (after?.path !== before?.path ? "Household creates the folder." : "The folder is not there now (an unplugged disk?): it is mounted once it is back.") : "",
        restarted.length ? `Approving restarts the VM of ${title(restarted)}${house.pets.some(p => p.sideworker && restarted.includes(p.sideworker.parent)) ? " and their sideworkers" : ""} once its turn ends (homes stay).` : "",
        "Expires in 10 minutes.",
      ].filter(Boolean).join(" "),
    });
    return {
      text, format: "html", start: "waiting",
      view: state => state === "waiting" ? { choices: [[action === "delete" ? "Stop sharing" : "Approve"], ["Deny"]] } : { outcome: state === "approve" ? "Approved" : "Denied" },
      press: (state, index) => state === "waiting" ? (index === 0 ? "approve" : index === 1 ? "deny" : state) : state,
    };
  }

  /** Lets the touched bots finish their turns, writes the change and reloads, then tells the asking bot. */
  private async apply(house: string, pet: string, action: Action, name: string, after: Volume | undefined, snapshot: Volume | null): Promise<void> {
    const current = await this.options.current(house);
    if (!current?.pets.some(p => p.name === pet)) throw new Error("the bot is gone");
    if (JSON.stringify(current.volumes?.find(volume => volume.name === name) ?? null) !== JSON.stringify(snapshot)) throw new Error("the volume changed while waiting for approval");
    if (after?.bots.some(bot => !current.pets.some(p => p.name === bot))) throw new Error("one of its bots is gone");
    // Checked again: the folder may have changed in the minutes the card waited (a part of its path made a link).
    const fresh = after && (await inspectFolder(after.path, this.options.protectedDirs)).path;
    if (after && fresh !== after.path) throw new Error("the folder is no longer the one that was shown");
    // Made only for a new folder: an unplugged disk's mount point is not filled with an empty one.
    if (after && after.path !== snapshot?.path) await ensureFolder(after.path);
    const touched = botsTouched(snapshot ? [snapshot] : [], after ? [after] : []);
    const releases: (() => void)[] = [];
    try {
      const vms = await this.options.affected(house, touched);
      const done = await Promise.allSettled(vms.map(vm => this.options.prepareRestart(house, vm, vm === pet
        ? `Household: your human approved your folder request (${action} ${name}). Household will restart your VM to apply it. Save what you need to Household memory now, then finish this turn; do not start new work. Your home stays. You have at most three minutes.`
        : `Household: your human changed the shared folders of your workspace (${name}). Household will restart your VM to apply it. Save what you need to Household memory now, then finish this turn; do not start new work. Your home stays. You have at most three minutes.`)));
      for (const result of done) if (result.status === "fulfilled") releases.push(result.value);
      if (this.stopped) throw new Error("Household stopped before it could apply it");
      await this.options.write(house, name, after, snapshot);
    } finally {
      for (const release of releases) release();
    }
    this.options.log(`volume ${action}: ${house}/${pet} ${name} approved`);
    this.notify(house, pet, action === "delete"
      ? `Household: folder ${name} is no longer shared; ${volumeTarget(name)} is gone from your VM. Its files stay on your human's computer.`
      : `Household: folder ${name} is mounted at ${volumeTarget(name)} (${accessWord(after!.access)}) for ${after!.bots.join(", ")}.${after!.bots.includes(pet) ? "" : " You are not one of its bots, so it is not in your VM."}`);
  }

  private notify(house: string, pet: string, text: string): void {
    try { this.options.notify(house, pet, text); } catch { /* the asking bot may be gone */ }
  }

  /** Drops the requests of bots that left the config. */
  setPets(pets: { house: string; pet: string }[]): void {
    for (const [house, pending] of this.pending) if (!pets.some(p => p.house === house && p.pet === pending.pet)) pending.controller.abort();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const pending of this.pending.values()) pending.controller.abort();
    await Promise.allSettled(this.tasks);
  }
}

export function volumeRequestTool(requests: VolumeRequests): McpTool<PetIdentity> {
  return {
    name: VOLUME_REQUEST_TOOL,
    description: "RESTARTS YOUR VM: once your human approves a change to your own folders, Household asks you to finish your turn and then restarts your VM to mount it, so this session ends (your home and Household memory stay; save what you need to memory before or when asked). Every other bot the change touches restarts the same way; the result says restarts_vm_if_approved. Ask your human to share a folder of their computer with bots of your workspace (create), change one (update: its folder, access or bots), or stop sharing it (delete). Each needs their approval in the chat. A folder is mounted at /volumes/<name>, read-only or read-write for all its bots alike; one that does not exist is created. path is a host path, absolute or ~/…; bots default to you on create. Delete unmounts only: the files stay. One request per workspace at a time; returns at once, and Household tells you the outcome after the restart.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name", "reason"], properties: {
      action: { type: "string", enum: ["create", "update", "delete"] },
      name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,30}$" },
      path: { type: "string", maxLength: 1024 },
      access: { type: "string", enum: [...VOLUME_ACCESS] },
      bots: { type: "array", items: { type: "string" }, maxItems: 64 },
      reason: { type: "string", minLength: 1, maxLength: 600 },
    } },
    async call({ house, pet }, args) {
      return JSON.stringify(await requests.request(house, pet, { action: args.action, name: args.name, path: args.path, access: args.access, bots: args.bots, reason: args.reason }));
    },
  };
}
