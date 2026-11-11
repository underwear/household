import { useState } from "react";
import { api, type MeView, type OwnerView } from "../api";
import { Dialog } from "./dialog";
import { SelectField, TextField } from "./fields";
import { PlatformIcon } from "./icon";
import { ListSection, type SectionProps } from "./section";

/**
 * The workspace's owners, each on a platform (one some kind of channel is on: a select, even with one), by the id it
 * knows them by, as the platform describes it, with a note of the owner's if they like (for them only): their
 * messages are the owner's; anyone else who writes is a guest.
 */
export function OwnersSection({ house, ask, save, platforms, noteMax }: SectionProps & { platforms: MeView["platforms"]; noteMax?: number }) {
  /** The owner being edited, or "new". */
  const [editing, setEditing] = useState<OwnerView | "new">();
  const labelOf = (name: string) => platforms.find((candidate) => candidate.platform === name)?.label ?? name;
  const shown = (owner: { platform: string; id: string }) => `${labelOf(owner.platform)} · ${owner.id}`;
  const ownerOf = (key: string) => house.owners.find((each) => `${each.platform}/${each.id}` === key)!;
  return (
    <>
      <ListSection
        title="Owners"
        hint="Bots obey owners only. Anyone else is a guest."
        actions={
          <button className="btn small" onClick={() => setEditing("new")}>
            + Add owner
          </button>
        }
        empty="No owners. You can add channels now and add owners later. Until then, everyone is a guest."
        items={house.owners.map((owner) => ({
          key: `${owner.platform}/${owner.id}`,
          lead: <PlatformIcon platforms={platforms} platform={owner.platform} />,
          // Who they are, when the owner's note says; else the platform. Its id under it.
          label: owner.note ?? labelOf(owner.platform),
          sub: owner.note ? `${labelOf(owner.platform)} · ${owner.id}` : owner.id,
          problem: owner.problem,
        }))}
        onEdit={(key) => setEditing(ownerOf(key))}
        onRemove={(key) => {
          const owner = ownerOf(key);
          ask({
            title: `Remove owner ${shown(owner)}?`,
            body: "They become a guest.",
            confirmLabel: "Remove",
            danger: true,
            onConfirm: () => save(api.removeOwner(house.name, owner.platform, owner.id), `${shown(owner)} removed`),
          });
        }}
      />
      {editing && (
        <OwnerDialog
          platforms={platforms}
          owner={editing === "new" ? undefined : editing}
          noteMax={noteMax}
          onClose={() => setEditing(undefined)}
          save={(owner) =>
            editing === "new"
              ? save(api.addOwner(house.name, owner.platform, owner.id, owner.note || null), `${shown(owner)} is an owner`)
              : save(api.updateOwner(house.name, editing.platform, editing.id, owner.note || null), `${shown(editing)} saved`)
          }
        />
      )}
    </>
  );
}

/**
 * An owner's form: the platform (a select, even with one) and the id it knows them by, as the platform describes it,
 * then a note for the owner only (never told to a bot). Editing changes only the note: another id is another owner.
 */
export function OwnerDialog({
  platforms,
  owner,
  noteMax,
  onClose,
  save,
}: {
  platforms: MeView["platforms"];
  owner?: OwnerView;
  noteMax?: number;
  onClose: () => void;
  save: (owner: { platform: string; id: string; note: string }) => Promise<void>;
}) {
  const [platform, setPlatform] = useState(owner?.platform ?? platforms[0]?.platform ?? "");
  const [id, setId] = useState(owner?.id ?? "");
  const [note, setNote] = useState(owner?.note ?? "");
  const spec = platforms.find((candidate) => candidate.platform === platform);
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: owner ? `Edit ${spec?.label ?? owner.platform} · ${owner.id}` : "Add owner",
        confirmLabel: owner ? "Save" : "Add owner",
        onConfirm: () => save({ platform, id: id.trim(), note: note.trim() }),
        children: (
          <>
            {!owner && (
              <>
                <SelectField label="Platform" value={platform} onChange={setPlatform} options={platforms.map((each) => ({ value: each.platform, label: each.label }))} />
                <TextField label={spec?.ownerId.label ?? "Owner id"} hint={spec?.ownerId.hint} mono value={id} onChange={setId} placeholder={spec?.ownerId.placeholder} />
              </>
            )}
            <TextField label="Note" hint="Only you see this." value={note} onChange={setNote} placeholder="my wife's phone" maxLength={noteMax} />
          </>
        ),
      }}
    />
  );
}
