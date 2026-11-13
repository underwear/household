import { createInterface } from "node:readline/promises";
import type { VolumesView } from "../app/web-views";
import { HouseholdError } from "../core/errors";
import { findHouse } from "../core/household";
import { describeFiles, nestingIn, VOLUME_ACCESS, type VolumeAccess } from "../core/volumes";
import type { ConfigStore } from "../infra/config-store";
import { callControl } from "../infra/control-socket";
import type { Paths } from "../infra/paths";
import { ensureFolder, inspectFolder, protectedFolders, type FolderInfo } from "../infra/volume-folders";
import type { ApiAnswer, ApiCall } from "../app/daemon";

export const VOLUME_USAGE = `  house volume ls <workspace>    its shared folders (where, how, for which bots) and its bots' homes
  house volume add <workspace> <name> --path <folder> [--access read|write] [--bots a,b] [--note <text>] [--yes]
                                 share a folder of this computer with bots, at /volumes/<name> in their VMs
                                 (read by default; a missing folder is created; one with files asks first unless
                                 --yes); their VMs restart to mount it, their homes stay
  house volume set <workspace> <name> [--path <folder>] [--access read|write] [--bots a,b] [--note <text>] [--yes]
  house volume rm <workspace> <name>  stop sharing it: unmounted from its bots' VMs; the folder and its files stay`;

export interface VolumeValues {
  path?: string;
  access?: string;
  pets?: string;
  note?: string;
  yes?: boolean;
}

const enc = encodeURIComponent;

/** The daemon's answer to an API call, or undefined when it is not running. */
async function call<T>(paths: Paths, method: ApiCall["method"], path: string, body?: unknown): Promise<T | undefined> {
  const answer = await callControl<ApiAnswer>(paths.socket, "/api", { method, path, ...(body === undefined ? {} : { body }) } satisfies ApiCall);
  if (!answer) return undefined;
  if (answer.status >= 400) throw new HouseholdError((answer.body as { error?: string } | null)?.error ?? `daemon: HTTP ${answer.status}`);
  return answer.body as T;
}

const accessOf = (text: string | undefined): VolumeAccess | undefined => {
  if (text === undefined) return undefined;
  if (!VOLUME_ACCESS.includes(text as VolumeAccess)) throw new HouseholdError("--access read|write");
  return text as VolumeAccess;
};
const botsOf = (text: string | undefined) => text === undefined ? undefined : text.split(",").map((bot) => bot.trim()).filter(Boolean);

/** Says what is in the folder; a folder with files is shared only once the person says yes (or gave --yes). */
async function confirmFolder(folder: FolderInfo, yes: boolean | undefined): Promise<void> {
  console.log(`${folder.path}: ${describeFiles(folder)}`);
  if (folder.warning) console.log(`warning: ${folder.warning}`);
  if (yes || (!folder.warning && (!folder.exists || folder.files === 0))) return;
  if (!process.stdin.isTTY) throw new HouseholdError("the folder is not empty: run again with --yes to share it");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`share it with these bots? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) throw new HouseholdError("nothing changed");
  } finally { prompt.close(); }
}

export async function runVolumes(paths: Paths, config: ConfigStore, notify: () => Promise<void>, args: string[], values: VolumeValues): Promise<boolean> {
  const [verb, house, name] = args;
  const say = (text: string) => console.log(text);
  if (verb === "ls" && args.length === 2) {
    const view = await call<VolumesView>(paths, "GET", `/api/houses/${enc(house!)}/volumes`);
    const volumes = view?.volumes ?? (findHouse(await config.load(), house!) ?? (() => { throw new HouseholdError(`unknown workspace '${house}'`); })()).volumes?.map((v) => ({ ...v, target: `/volumes/${v.name}`, present: true, note: v.note ?? null })) ?? [];
    if (volumes.length === 0) say("no shared folders");
    for (const v of volumes) say(`volume ${v.name}  ${v.path} → ${v.target}  ${v.access === "write" ? "read-write" : "read-only"}  bots: ${v.bots.join(", ") || "-"}${v.present ? "" : "problem" in v && v.problem === "unsafe" ? "  ! not mounted: no longer the folder that was shared" : "  ! folder missing: not mounted"}${v.note ? `  (${v.note})` : ""}`);
    for (const home of view?.homes ?? []) say(`home ${home.bot}${home.parent ? ` (sideworker of ${home.parent})` : ""}  ${home.hostPath} → ${home.guestPath}${home.sharedWith.length ? `  also in: ${home.sharedWith.map((s) => `${s.bot} at ${s.at}`).join(", ")}` : ""}`);
    return true;
  }
  if (verb === "add" && args.length === 3) {
    if (!values.path) throw new HouseholdError(`--path is required\n${VOLUME_USAGE}`);
    const folder = await inspectFolder(values.path, protectedFolders(paths));
    const fields = { path: folder.path, access: accessOf(values.access) ?? "read", bots: botsOf(values.pets) ?? [], ...(values.note ? { note: values.note } : {}) };
    const nested = nestingIn((await config.load()).houses, house!, name!, folder.path, fields.access);
    if (nested) throw new HouseholdError(nested);
    await confirmFolder(folder, values.yes);
    if (await call(paths, "POST", `/api/houses/${enc(house!)}/volumes`, { name, ...fields }) === undefined) {
      await ensureFolder(folder.path);
      await config.putVolume(house!, name!, fields, { create: true });
      await notify();
    }
    say(`volume '${name}' shares ${folder.path} at /volumes/${name} (${fields.access === "write" ? "read-write" : "read-only"}) with ${fields.bots.join(", ") || "no bots yet"}`);
    return true;
  }
  if (verb === "set" && args.length === 3) {
    const current = findHouse(await config.load(), house!)?.volumes?.find((volume) => volume.name === name);
    if (!current) throw new HouseholdError(`unknown volume '${house}/${name}'`);
    let path = current.path;
    const access = accessOf(values.access) ?? current.access;
    if (values.path !== undefined || (access === "write" && current.access === "read")) {
      const folder = await inspectFolder(values.path ?? current.path, protectedFolders(paths));
      if (values.path === undefined && folder.path !== current.path) throw new HouseholdError(`the folder of '${name}' is no longer the one that was shared (a part of its path is a link now): give --path again`);
      if (folder.path !== current.path || access !== current.access) await confirmFolder(folder, values.yes);
      path = folder.path;
    }
    const note = values.note === undefined ? current.note : values.note || undefined;
    const fields = { path, access, bots: botsOf(values.pets) ?? current.bots, ...(note ? { note } : {}) };
    if (await call(paths, "PUT", `/api/houses/${enc(house!)}/volumes/${enc(name!)}`, fields) === undefined) {
      if (path !== current.path) await ensureFolder(path);
      await config.putVolume(house!, name!, fields);
      await notify();
    }
    say(`volume '${name}' changed`);
    return true;
  }
  if (verb === "rm" && args.length === 3) {
    if (await call(paths, "DELETE", `/api/houses/${enc(house!)}/volumes/${enc(name!)}`) === undefined) {
      await config.removeVolume(house!, name!);
      await notify();
    }
    say(`volume '${name}' removed: unmounted from its bots; the folder and its files stay`);
    return true;
  }
  return false;
}
