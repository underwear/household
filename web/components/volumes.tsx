import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Home, RotateCcw, TriangleAlert } from "lucide-react";
import { api, type FolderInfo, type VolumeAccess, type VolumeView, type VolumesView, type WorkspaceView, type BotView } from "../api";
import { describeFiles, volumeTarget } from "../../src/core/volumes";
import { botPath, workspacePath } from "../router";
import { Dialog, useDialog } from "./dialog";
import { CheckList, ChoiceList, Switch, TextField } from "./fields";
import { Cell, List, ListRow, Page, Section } from "./layout";
import { Link } from "./link";
import { RowActions, written } from "./section";

type Notify = (text: string, warning?: boolean) => void;

const ACCESS_WORDS: Record<VolumeAccess, string> = { read: "Read-only", write: "Read-write" };
/** The bots a volume can be for: the workspace's own, not its sideworkers (they see their parent's). */
const botsOf = (house: WorkspaceView) => house.pets.filter((pet) => !pet.sideworker);
const titleOf = (house: WorkspaceView, bot: string) => house.pets.find((pet) => pet.name === bot)?.display ?? bot;

/** Why a volume is not mounted, in a line. */
const problemText = (volume: VolumeView) => volume.problem === "unsafe"
  ? "Not mounted: the folder is no longer the one that was shared (a link now?). Share it again."
  : "Folder missing: not mounted. Restart its bots once it is back.";

/** The workspace's volumes and homes, loaded, and how to save a change and load them again. */
function useVolumes(house: string, notify: Notify) {
  const [view, setView] = useState<VolumesView>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => api.volumes(house).then((found) => { setView(found); setError(undefined); }, (e: Error) => setError(e.message)), [house]);
  useEffect(() => void load(), [load]);
  const save = async (write: Promise<unknown>, done: string) => {
    try {
      const warning = await written(write);
      notify(warning ?? done, warning !== undefined);
    } finally {
      await load();
    }
  };
  return { view, error, save };
}

/** Bots as chips, each a link to its page. */
function BotChips({ house, bots }: { house: WorkspaceView; bots: string[] }) {
  if (bots.length === 0) return <span className="faint">No bots yet</span>;
  return (
    <span className="cluster gap-1">
      {bots.map((bot) => (
        <Link key={bot} href={botPath(house.name, bot, "volumes")} className="chip">{titleOf(house, bot)}</Link>
      ))}
    </span>
  );
}

/**
 * Workspace · Volumes: folders of this computer shared with bots, at /volumes/<name> in their VMs, and, to see what is
 * where, every bot's home (Household's own: shown, not changed here).
 */
export function VolumesPage({ house, notify }: { house: WorkspaceView; notify: Notify }) {
  const { view, error, save } = useVolumes(house.name, notify);
  const [editing, setEditing] = useState<{ volume?: VolumeView }>();
  const dialog = useDialog();
  const remove = (volume: VolumeView) =>
    dialog.open({
      title: `Stop sharing ${volume.name}?`,
      body: <>It is unmounted from {volume.bots.length ? volume.bots.map((bot) => titleOf(house, bot)).join(", ") : "every bot"}; their VMs restart (homes stay). <strong>The folder and its files stay</strong> at <code>{volume.path}</code>.</>,
      confirmLabel: "Stop sharing",
      danger: true,
      onConfirm: () => save(api.removeVolume(house.name, volume.name), `${volume.name} is no longer shared; its files stay`),
    });
  return (
    <Page title="Volumes" actions={<button type="button" className="btn primary" onClick={() => setEditing({})}>+ Share folder</button>}>
      <Section title="Shared folders" hint={<>Folders of this computer your bots see at <code>/volumes/&lt;name&gt;</code>, read-only or read-write for all of their bots. Bots can ask for one in the chat; you approve each. A change restarts the bots it touches (their homes stay); removing one never deletes its files.</>}>
        {error && <p className="error" role="alert">{error}</p>}
        <VolumeList house={house} volumes={view?.volumes} onEdit={(volume) => setEditing({ volume })} onRemove={remove} empty={view ? "No folders shared yet." : "Loading…"} />
      </Section>
      <HomesSection house={house} homes={view?.homes} />
      {editing && (
        <VolumeDialog
          house={house}
          volume={editing.volume}
          taken={(view?.volumes ?? []).map(({ name }) => name)}
          onClose={() => setEditing(undefined)}
          save={(name, fields) => save(editing.volume ? api.updateVolume(house.name, name, fields) : api.addVolume(house.name, name, fields), editing.volume ? `${name} saved` : `${name} shared at ${volumeTarget(name)}`)}
        />
      )}
      {dialog.element}
    </Page>
  );
}

function VolumeList({ house, volumes, onEdit, onRemove, empty }: { house: WorkspaceView; volumes?: VolumeView[]; onEdit: (volume: VolumeView) => void; onRemove: (volume: VolumeView) => void; empty: string }) {
  return (
    <List columns="minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1.2fr) auto" head={["Folder", "In the VM", "Bots"]} empty={empty}>
      {(volumes ?? []).map((volume) => (
        <ListRow key={volume.name} actions={<RowActions onEdit={() => onEdit(volume)} onRemove={() => onRemove(volume)} />}>
          <Cell lines>
            <span className="strong ellipsis">{volume.name}</span>
            <span className="mono ellipsis muted" title={volume.path}>{volume.path}</span>
            {!volume.present && (
              <span className="hint danger">
                <TriangleAlert size={13} strokeWidth={2} aria-hidden /> {problemText(volume)}
              </span>
            )}
            {volume.note && <span className="faint ellipsis" title={volume.note}>{volume.note}</span>}
          </Cell>
          <Cell label="In the VM" lines>
            <span className="mono ellipsis">{volume.target}</span>
            <span className="faint">{ACCESS_WORDS[volume.access]}</span>
          </Cell>
          <Cell label="Bots" wrap>
            <BotChips house={house} bots={volume.bots} />
          </Cell>
        </ListRow>
      ))}
    </List>
  );
}

/** Every bot's home: where it is on this computer and in the VM, and which sideworkers see it too. Read-only. */
function HomesSection({ house, homes, only }: { house: WorkspaceView; homes?: VolumesView["homes"]; only?: string }) {
  const shown = (homes ?? []).filter((home) => !only || home.bot === only || home.sharedWith.some((s) => s.bot === only));
  return (
    <Section title={only ? "Home" : "Bot homes"} hint={only ? "Household's own: its files, sessions and tools. It stays when the VM is recreated." : "Each bot's home, kept by Household: shown so you can see what is where. Sideworkers see their parent's."}>
      <List columns="minmax(0, 0.8fr) minmax(0, 1.4fr) minmax(0, 1fr)" head={["Bot", "On this computer", "In the VM"]} empty={homes ? "No bots yet." : "Loading…"}>
        {shown.map((home) => (
          <ListRow key={home.bot}>
            <Cell lines>
              <span className="cluster gap-1 strong ellipsis"><Home size={14} aria-hidden /> {titleOf(house, home.bot)}</span>
              {home.parent && <span className="faint">sideworker of {titleOf(house, home.parent)}</span>}
            </Cell>
            <Cell label="On this computer">
              <span className="mono ellipsis muted" title={home.hostPath}>{home.hostPath}</span>
            </Cell>
            <Cell label="In the VM" lines>
              <span className="mono ellipsis">{home.guestPath}</span>
              {home.sharedWith.map((shared) => <span key={shared.bot} className="faint ellipsis">also {titleOf(house, shared.bot)}, at <span className="mono">{shared.at}</span></span>)}
            </Cell>
          </ListRow>
        ))}
      </List>
    </Section>
  );
}

/**
 * Sharing a folder, or changing one: its name (new ones), the folder, read-only or read-write, its bots, a note.
 * Before a folder with files (or one that may hold credentials) is shared, a second step says what is in it and asks.
 */
export function VolumeDialog({ house, volume, taken = [], bots: startBots, onClose, save }: { house: WorkspaceView; volume?: VolumeView; taken?: string[]; /** A new one's bots to start with (from a bot's page). */ bots?: string[]; onClose: () => void; save: (name: string, fields: { path: string; access: VolumeAccess; bots: string[]; note: string | null }) => Promise<void> }) {
  const [name, setName] = useState(volume?.name ?? "");
  const [path, setPath] = useState(volume?.path ?? "");
  const [access, setAccess] = useState<VolumeAccess>(volume?.access ?? "read");
  const [bots, setBots] = useState<string[]>(volume?.bots ?? startBots ?? []);
  const [note, setNote] = useState(volume?.note ?? "");
  const [checked, setChecked] = useState<FolderInfo>();
  const nameError = !volume && name.trim() && !/^[a-z][a-z0-9-]{0,30}$/.test(name.trim()) ? "a–z first, then a–z, 0–9 or -" : !volume && taken.includes(name.trim()) ? `${name.trim()} is already shared.` : undefined;
  const fields = () => ({ path: (checked?.path ?? path).trim(), access, bots, note: note.trim() || null });
  const touched = volume ? [...new Set([...volume.bots, ...bots])] : bots;
  const restartNote = touched.length > 0 && (
    <p className="check-note info">
      <RotateCcw size={14} strokeWidth={2} aria-hidden />
      <span>{touched.map((bot) => titleOf(house, bot)).join(", ")} restart{touched.length === 1 ? "s" : ""} to apply it (homes stay).</span>
    </p>
  );
  if (checked) {
    const empty = checked.exists && checked.files === 0;
    return (
      <Dialog
        onClose={onClose}
        spec={{
          title: !checked.exists && checked.path !== volume?.path ? `Create ${checked.path}?` : !checked.exists ? `${checked.path} is not there now` : empty ? `Share ${checked.path}?` : `This folder holds ${describeFiles(checked)}`,
          step: "confirm",
          back: () => setChecked(undefined),
          confirmLabel: !checked.exists && checked.path !== volume?.path ? "Create and share" : volume ? "Save" : "Share it",
          danger: access === "write" && !empty && checked.exists,
          onConfirm: () => save(name.trim(), fields()),
          body: (
            <>
              <p>
                {bots.length ? bots.map((bot) => titleOf(house, bot)).join(", ") : "No bot yet"} {bots.length === 1 ? "gets" : "get"} <code>{checked.path}</code> at <code>{volumeTarget(name.trim() || volume!.name)}</code>, <strong>{ACCESS_WORDS[access].toLowerCase()}</strong>
                {access === "write" && checked.exists && !empty ? ": they can change and delete what is in it, and Household cannot undo that." : "."}
              </p>
              {checked.warning && (
                <p className="check-note">
                  <TriangleAlert size={14} strokeWidth={2} aria-hidden />
                  <span>Careful: {checked.warning}.</span>
                </p>
              )}
              {restartNote}
            </>
          ),
        }}
      />
    );
  }
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: volume ? `Edit ${volume.name}` : "Share a folder",
        wide: true,
        confirmLabel: "Next",
        onConfirm: async () => {
          if (nameError) throw new Error(nameError);
          if (!volume && !name.trim()) throw new Error("Give it a name: it is its folder in the VM.");
          if (!path.trim()) throw new Error("Which folder of this computer?");
          // An unchanged folder needs no second look; a new one says what is in it before it is shared.
          if (volume && path.trim() === volume.path && !(access === "write" && volume.access === "read")) return save(volume.name, fields());
          const info = await api.checkVolume(house.name, path.trim());
          if (info.exists && info.files === 0 && !info.warning && volume) return save(volume.name, { ...fields(), path: info.path });
          setChecked(info);
          return "stay";
        },
        children: (
          <>
            {!volume && <TextField label="Name" mono value={name} onChange={setName} placeholder="projects" error={nameError} hint={<>Bots see it at <code>{volumeTarget(name.trim() || "name")}</code>.</>} />}
            <TextField label="Folder on this computer" mono value={path} onChange={setPath} placeholder="~/Projects/shared" hint="An absolute path or ~/…; a folder that does not exist yet is created." />
            <ChoiceList
              label="Access"
              value={access}
              onChange={(chosen) => setAccess(chosen as VolumeAccess)}
              options={[
                { value: "read", label: "Read-only", description: "Bots read it; they cannot change anything in it." },
                { value: "write", label: "Read-write", description: "Bots can add, change and delete its files, on this computer, at once." },
              ]}
            />
            <CheckList
              label="Bots"
              checked={bots}
              options={botsOf(house).map((pet) => ({ value: pet.name, label: pet.display }))}
              onToggle={(bot) => setBots((previous) => (previous.includes(bot) ? previous.filter((each) => each !== bot) : [...previous, bot]))}
              empty="No bots in this workspace yet."
            />
            <TextField label="Note" hint="Only you see this." value={note} onChange={setNote} maxLength={200} />
            {restartNote}
          </>
        ),
      }}
    />
  );
}

/**
 * A bot's Volumes tab: the workspace's shared folders, each switched on or off for this bot (a switch restarts it),
 * sharing a new one for it, and its home.
 */
export function BotVolumes({ house, pet, notify }: { house: WorkspaceView; pet: BotView; notify: Notify }) {
  const { view, error, save } = useVolumes(house.name, notify);
  const [adding, setAdding] = useState(false);
  const dialog = useDialog();
  const restart = pet.enabled ? "Its VM restarts (its home stays)." : "It gets it when you enable it.";
  const toggle = (volume: VolumeView, on: boolean) =>
    dialog.open({
      title: on ? `Mount ${volume.name} for ${pet.title}?` : `Unmount ${volume.name} from ${pet.title}?`,
      body: on
        ? <>{pet.title} gets <code>{volume.path}</code> at <code>{volume.target}</code>, {ACCESS_WORDS[volume.access].toLowerCase()}. {restart}</>
        : <>{pet.title} no longer sees <code>{volume.target}</code>; the folder and its files stay. {pet.enabled ? restart : ""}</>,
      confirmLabel: pet.enabled ? (on ? "Mount and restart" : "Unmount and restart") : on ? "Mount" : "Unmount",
      onConfirm: () => save(api.updateVolume(house.name, volume.name, { path: volume.path, access: volume.access, bots: on ? [...volume.bots, pet.name] : volume.bots.filter((bot) => bot !== pet.name), note: volume.note }), on ? `${volume.name} mounted for ${pet.title}` : `${volume.name} unmounted from ${pet.title}`),
    });
  const volumes = view?.volumes ?? [];
  return (
    <>
      <Section
        title="Shared folders"
        hint={<>Folders of this computer {pet.title} sees at <code>/volumes/&lt;name&gt;</code>. It can ask for more in the chat; you approve each. All of the workspace's are on its <Link href={workspacePath(house.name, "volumes")} className="text-link">Volumes</Link> page.</>}
        actions={<button type="button" className="btn small" onClick={() => setAdding(true)}>+ Share folder</button>}
      >
        {error && <p className="error" role="alert">{error}</p>}
        <List columns="minmax(0, 1.4fr) minmax(0, 1fr) auto" head={["Folder", "In the VM"]} empty={view ? "No folders are shared in this workspace yet." : "Loading…"}>
          {volumes.map((volume) => {
            const on = volume.bots.includes(pet.name);
            return (
              <ListRow key={volume.name} actions={<Switch label={`Mounted for ${pet.title}`} hideLabel on={on} onChange={(next) => toggle(volume, next)} />}>
                <Cell lines>
                  <span className="cluster gap-1 strong ellipsis"><FolderOpen size={14} aria-hidden /> {volume.name}</span>
                  <span className="mono ellipsis muted" title={volume.path}>{volume.path}</span>
                  {!volume.present && <span className="hint danger"><TriangleAlert size={13} strokeWidth={2} aria-hidden /> {problemText(volume)}</span>}
                </Cell>
                <Cell label="In the VM" lines>
                  <span className={`mono ellipsis${on ? "" : " faint"}`}>{volume.target}</span>
                  <span className="faint">{on ? ACCESS_WORDS[volume.access] : "Not mounted"}{volume.bots.some((bot) => bot !== pet.name) ? ` · ${on ? "also" : "for"} ${volume.bots.filter((bot) => bot !== pet.name).map((bot) => titleOf(house, bot)).join(", ")}` : ""}</span>
                </Cell>
              </ListRow>
            );
          })}
        </List>
      </Section>
      <HomesSection house={house} homes={view?.homes} only={pet.name} />
      {adding && (
        <VolumeDialog
          house={house}
          bots={[pet.name]}
          taken={volumes.map(({ name }) => name)}
          onClose={() => setAdding(false)}
          save={(name, fields) => save(api.addVolume(house.name, name, fields), `${name} shared at ${volumeTarget(name)}`)}
        />
      )}
      {dialog.element}
    </>
  );
}


