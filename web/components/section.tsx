import { useState, type ReactNode } from "react";
import { NotApplied, type WorkspaceView, type WriteView } from "../api";
import type { DialogSpec } from "./dialog";
import { Cell, List, ListRow, Section, type SectionWidth } from "./layout";

/** What a section of Workspace settings gets: the workspace, a confirmation dialog, and how to save. */
export interface SectionProps {
  house: WorkspaceView;
  ask: (spec: DialogSpec) => void;
  /** Runs a write, then refetches the workspaces (whatever happened) and says `done`, or the warning. */
  save: (write: Promise<WriteView>, done: string) => Promise<void>;
}

/**
 * Runs a write; resolves to the daemon's warning when it saved the change but could not apply it, or is still
 * applying it (a done write, not a failed one), undefined when all went well. Any other failure throws (nothing was saved).
 */
export async function written(write: Promise<unknown>): Promise<string | undefined> {
  try {
    const answer = await write;
    // Saved; the reload is still going (a bot starting holds it): not a failure, but not done yet either.
    if (answer && typeof answer === "object" && "applying" in answer && answer.applying) return "Saved. Household is still applying it (a bot is starting): give it a minute.";
    return undefined;
  } catch (error) {
    if (error instanceof NotApplied) return error.message;
    throw error;
  }
}

/** Edit and Remove, at a row's end. */
export function RowActions({ onEdit, onRemove }: { onEdit: () => void; onRemove: () => void }) {
  return (
    <>
      <button className="text-btn plain" onClick={onEdit}>
        Edit
      </button>
      <button className="text-btn" onClick={onRemove}>
        Remove
      </button>
    </>
  );
}

export interface ListSectionProps {
  title: string;
  hint?: ReactNode;
  /** What adds an entry: an inline AddForm, or a button in the section's head (`actions`) that opens a dialog. */
  form?: ReactNode;
  actions?: ReactNode;
  /** What an empty list says. */
  empty: string;
  /**
   * The entries, by key; one with a `tag` shows it instead of Remove (it cannot be removed here); a `warning` (in
   * the danger tone) shows before its actions; a `note` (the owner's own words) and a `problem` show under it.
   */
  items: { key: string; lead?: ReactNode; label: ReactNode; sub?: ReactNode; mono?: boolean; tag?: string; warning?: string; note?: string | null; problem?: string | null }[];
  onRemove: (key: string) => void;
  removeLabel?: string;
  /** Edit on each entry (its note, …), when there is anything to edit. */
  onEdit?: (key: string) => void;
  width?: SectionWidth;
}

/** A list of plain entries (hosts, owners): a form to add one, Remove on each. */
export function ListSection({ title, hint, form, actions, empty, items, onRemove, onEdit, removeLabel = "Remove", width }: ListSectionProps) {
  return (
    <Section title={title} hint={hint} actions={actions} width={width}>
      {form}
      <List empty={empty}>
        {items.map(({ key, lead, label, sub, mono, tag, warning, note, problem }) => (
          <ListRow
            key={key}
            actions={
              <>
                {warning && <span className="tag danger">{warning}</span>}
                {tag ? (
                  <span className="tag">{tag}</span>
                ) : onEdit ? (
                  <RowActions onEdit={() => onEdit(key)} onRemove={() => onRemove(key)} />
                ) : (
                  <button className="text-btn" onClick={() => onRemove(key)}>
                    {removeLabel}
                  </button>
                )}
              </>
            }
          >
            <Cell mono={mono}>
              {lead}
              <span className="cell-lines">
                <span className={mono ? "ellipsis" : "strong ellipsis"}>{label}</span>
                {sub && <span className="id ellipsis">{sub}</span>}
                {note && <span className="hint">{note}</span>}
                {problem && <span className="error">{problem}</span>}
              </span>
            </Cell>
          </ListRow>
        ))}
      </List>
    </Section>
  );
}

export interface AddFormProps {
  /** Its fields (labels hidden: the button says what they are for). */
  children: ReactNode;
  addLabel: string;
  /** Whether there is something to add. */
  ready: boolean;
  /** Adds the entry; a failure shows under the form. */
  onAdd: () => void | Promise<void>;
}

/** Fields side by side and the button that adds what they say (they wrap on a phone); the failure under them. */
export function AddForm({ children, addLabel, ready, onAdd }: AddFormProps) {
  const [problem, setProblem] = useState<string>();
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        setProblem(undefined);
        Promise.resolve()
          .then(onAdd)
          .catch((error) => setProblem((error as Error).message));
      }}
    >
      {children}
      <button className="btn primary" type="submit" disabled={!ready}>
        {addLabel}
      </button>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
