import { useEffect, useRef, useState } from "react";
import { BookOpen, FileCode2, FileText, Lock, Plus, RotateCcw, Trash2 } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { capabilityApi } from "../scout-api";
import { api, type BuiltinSkill, type SkillEntry, type SkillFile } from "../api";
import { Dialog, useDialog } from "./dialog";
import { TextField } from "./fields";
import { Cell, List, ListRow, Page, Section } from "./layout";
import { Link } from "./link";
import { MarkdownEditor } from "./markdown-editor";
import { housePath } from "../router";

const draftKey = (house: string, path: string) => `household:skill-draft:${house}:${path}`;
const hasDraft = (house: string, path: string) => {
  try {
    return sessionStorage.getItem(draftKey(house, path)) !== null;
  } catch {
    return false;
  }
};
const isMarkdown = (path: string) => /\.md$/i.test(path);
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A skill's frontmatter (`---` … `---` at its start), its fields by name, and the body after it. */
export function frontmatterOf(content: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return { fields: {}, body: content };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!] = field[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { fields, body: content.slice(match[0].length) };
}

/** A skill: its directory, and its files by their path inside it (SKILL.md first). */
interface Skill {
  name: string;
  files: SkillEntry[];
}

function skillsOf(entries: SkillEntry[]): Skill[] {
  const skills = new Map<string, Skill>();
  for (const entry of entries) {
    const [name, ...rest] = entry.path.split("/");
    if (!name) continue;
    const skill = skills.get(name) ?? { name, files: [] };
    skills.set(name, skill);
    if (rest.length > 0 && entry.kind !== "directory") skill.files.push(entry);
  }
  const rank = (entry: SkillEntry) => (entry.path.split("/").slice(1).join("/") === "SKILL.md" ? 0 : 1);
  for (const skill of skills.values()) skill.files.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  return [...skills.values()];
}

/** Markdown as it reads: no HTML, no remote images, links only to the web. A skill's frontmatter is its header. */
export function SkillPreview({ content, parseFrontmatter = true }: { content: string; parseFrontmatter?: boolean }) {
  const { fields, body } = parseFrontmatter ? frontmatterOf(content) : { fields: {} as Record<string, string>, body: content };
  return (
    <div className="skill-preview">
      {(fields.name || fields.description) && (
        <header className="skill-preview-head">
          {fields.name && <span className="skill-preview-name">{fields.name}</span>}
          {fields.description && <p>{fields.description}</p>}
        </header>
      )}
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: ({ alt }) => <span className="hint">[Image: {alt ?? "image"}]</span>,
          a: ({ href, children }) =>
            /^https?:\/\//.test(href ?? "") ? (
              <a href={href} target="_blank" rel="noreferrer" className="text-link">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {body}
      </Markdown>
    </div>
  );
}

/**
 * A house's skills: every pet in it reads (and may edit) the same files. Its skills on the left, each with its
 * description and, when chosen, its files; under them Household's built-in ones, read-only. The chosen file on the
 * right, in an editor or as it reads. Unsaved edits are kept in the browser per file (sessionStorage), and a save
 * says which revision it replaces, so a pet's edit in the meantime is not overwritten.
 */
export function SkillsPage({ house, pet, capability: scout, title = pet ?? scout, worker = false, notify }: {
  house: string;
  /** A pet's Skills tab: its own skills; a line says what else it has (the house's, Household's). */
  pet?: string;
  /** A capability's skills: copied into every scout that has it. */
  capability?: string;
  /** The pet's title, as the tab says it. */
  title?: string;
  /** The pet is a sideworker: its directory is a project, whose skills are the project's, not its own. */
  worker?: boolean;
  notify: (message: string, warning?: boolean) => void;
}) {
  const scope = scout ? `${house}/capability/${scout}` : pet ? `${house}/${pet}` : house;
  const [workspacePath, setWorkspacePath] = useState<string>();
  const [sharedNames, setSharedNames] = useState<Set<string>>();
  // Household's own skills: listed under the house's, counted on a pet's tab.
  const [builtin, setBuiltin] = useState<BuiltinSkill[]>([]);
  const [shownBuiltin, setShownBuiltin] = useState<BuiltinSkill>();
  useEffect(() => {
    let active = true;
    api.builtinSkills().then((rows) => active && setBuiltin(rows), () => {});
    return () => { active = false; };
  }, []);
  const files = {
    list: async () => {
      if (scout) return capabilityApi.skills(house, scout);
      if (!pet) return api.skills(house);
      const result = await api.petSkills(house, pet);
      setWorkspacePath(result.path);
      return result.entries;
    },
    read: (path: string) => scout ? capabilityApi.skill(house, scout, path) : pet ? api.petSkillFile(house, pet, path) : api.skillFile(house, path),
    save: (path: string, content: string, revision: string | null) => scout ? capabilityApi.saveSkill(house, scout, path, content, revision) : pet ? api.savePetSkillFile(house, pet, path, content, revision) : api.saveSkillFile(house, path, content, revision),
    delete: (path: string, revision: string) => scout ? capabilityApi.deleteSkill(house, scout, path, revision) : pet ? api.deletePetSkillFile(house, pet, path, revision) : api.deleteSkillFile(house, path, revision),
  };
  useEffect(() => {
    if (!pet && !scout) return;
    let active = true;
    // A pet's skill named as one of the house's: the agent sees two, so say so.
    api.skills(house).then(rows => { if (active) setSharedNames(new Set(skillsOf(rows).filter(skill => skill.files.some(({ path }) => path === `${skill.name}/SKILL.md`)).map(skill => skill.name))); }, () => {});
    return () => { active = false; };
  }, [house, pet, scout]);
  const [entries, setEntries] = useState<SkillEntry[]>([]);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState<SkillFile>();
  const [content, setContent] = useState("");
  const contentRef = useRef(content);
  contentRef.current = content;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [adding, setAdding] = useState<{ skill?: string }>();
  const request = useRef(0);
  const dialog = useDialog();
  const dirty = !!file && content !== file.content;
  const skills = skillsOf(entries);
  const currentSkill = file?.path.split("/")[0];

  /** Each skill's description, from its SKILL.md frontmatter. */
  const describe = async (names: string[]) => {
    const found = await Promise.all(
      names.map((name) =>
        files.read(`${name}/SKILL.md`).then(
          (skill) => [name, frontmatterOf(skill.content).fields.description ?? ""] as const,
          () => [name, ""] as const,
        ),
      ),
    );
    setDescriptions((known) => ({ ...known, ...Object.fromEntries(found) }));
  };
  const refresh = async () => {
    const rows = await files.list();
    setEntries(rows);
    return rows;
  };

  const open = async (path: string) => {
    setShownBuiltin(undefined);
    const id = ++request.current;
    setBusy(true);
    setError("");
    try {
      const next = await files.read(path);
      if (request.current !== id) return;
      let draft: { content: string; revision: string } | undefined;
      try {
        draft = JSON.parse(sessionStorage.getItem(draftKey(scope, path)) ?? "null") ?? undefined;
      } catch {}
      setFile(next);
      setContent(draft?.content ?? next.content);
      setPreview(false);
      if (draft && draft.revision !== next.revision && draft.content !== next.content) {
        setFile({ ...next, revision: draft.revision });
        setError("The file changed since you started. Copy your draft, then Reload.");
      }
    } catch (e) {
      if (request.current === id) setError((e as Error).message);
    } finally {
      if (request.current === id) setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    files.list().then(
      (rows) => {
        if (!active) return;
        setEntries(rows);
        const found = skillsOf(rows);
        void describe(found.map(({ name }) => name));
        const first = found.find(({ files }) => files.length > 0)?.files[0];
        if (first) void open(first.path);
      },
      (e) => active && setError(e.message),
    ).finally(() => active && setLoading(false));
    return () => {
      active = false;
      request.current++;
    };
  }, [house, pet, scout]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const edit = (value: string) => {
    setContent(value);
    if (!file) return;
    try {
      if (value === file.content) sessionStorage.removeItem(draftKey(scope, file.path));
      else sessionStorage.setItem(draftKey(scope, file.path), JSON.stringify({ content: value, revision: file.revision }));
    } catch {
      setError("Drafts aren't kept here: save before you leave.");
    }
  };

  const save = async () => {
    if (!file || busy || !dirty) return;
    setBusy(true);
    setError("");
    try {
      const next = await files.save(file.path, content, file.revision);
      if (contentRef.current === next.content) sessionStorage.removeItem(draftKey(scope, file.path));
      else sessionStorage.setItem(draftKey(scope, file.path), JSON.stringify({ content: contentRef.current, revision: next.revision }));
      setFile(next);
      notify(`${file.path} saved ${scout ? `for capability ${scout}` : pet ? `for ${pet}` : `for every pet in ${house}`}`);
      await refresh();
      if (file.path.endsWith("/SKILL.md")) void describe([file.path.split("/")[0]!]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reload = () =>
    file &&
    dialog.open({
      title: "Discard your changes?",
      body: `Your unsaved edits to ${file.path} are lost.`,
      confirmLabel: "Discard and reload",
      danger: true,
      onConfirm: async () => {
        sessionStorage.removeItem(draftKey(scope, file.path));
        await open(file.path);
      },
    });

  const removeFile = () =>
    file &&
    dialog.open({
      title: `Delete ${file.path}?`,
      body: scout ? "This file is removed from the capability’s skills." : pet ? `This file is removed from ${pet}’s workspace.` : "Every pet in the house loses this file.",
      confirmLabel: "Delete file",
      danger: true,
      onConfirm: async () => {
        await files.delete(file.path, file.revision);
        sessionStorage.removeItem(draftKey(scope, file.path));
        notify(`${file.path} deleted`);
        setFile(undefined);
        setContent("");
        await refresh();
      },
    });

  const removeSkill = (skill: Skill) =>
    dialog.open({
      title: `Delete the skill ${skill.name}?`,
      body: `${skill.files.length === 1 ? "Its file goes" : `All ${skill.files.length} of its files go`} ${scout ? "from the capability’s skills" : pet ? `from ${pet}’s workspace` : "for every pet in the house"}.`,
      confirmLabel: "Delete skill",
      danger: true,
      onConfirm: async () => {
        for (const entry of skill.files) {
          const current = await files.read(entry.path);
          await files.delete(entry.path, current.revision);
          sessionStorage.removeItem(draftKey(scope, entry.path));
        }
        notify(`Skill ${skill.name} deleted`);
        if (currentSkill === skill.name) {
          setFile(undefined);
          setContent("");
        }
        await refresh();
      },
    });

  const created = async (path: string) => {
    await refresh();
    void describe([path.split("/")[0]!]);
    await open(path);
  };

  const fileName = file?.path.split("/").slice(1).join("/");
  const markdownFile = !!file && isMarkdown(file.path);
  // A pet's: where its own are, and what else its agent sees (the house's and Household's, on Shared Skills).
  const hint = scout ? <>Copied into every scout that has this capability, with the house’s <Link href={housePath(house, "skills")} className="text-link">Shared Skills</Link> and Household’s built-in ones.</> : pet ? (
    <>
      {worker ? "The project's, in its working directory" : `Only ${title} has them, whatever its agent`}
      {workspacePath && <>: <span className="mono">{workspacePath}</span></>}.{" "}
      It also gets{" "}
      <Link href={housePath(house, "skills")} className="text-link">
        {sharedNames ? `${sharedNames.size} shared` : "the shared"} and {builtin.length || "the"} built-in skills
      </Link>.
    </>
  ) : (
    `Shared by every pet in ${house}. Pets can edit them too.`
  );
  const newSkill = !loading && skills.length > 0 && <button className="btn small" onClick={() => setAdding({})}>+ New skill</button>;
  const body = (
    <>
      <Section width="wide" title={scout ? "Skills" : pet && (worker ? "Project" : "Personal")} hint={hint} actions={(pet || scout) && newSkill}>
        {loading ? (
          <div className="skills-blank">
            <p className="hint">Loading skills…</p>
          </div>
        ) : skills.length === 0 ? (
          <div className="skills-blank">
            <BookOpen size={28} strokeWidth={1.5} aria-hidden />
            <span className="strong">{scout ? "No skills for this capability yet" : pet ? worker ? "No project skills here yet" : `${title} has no skills of its own yet` : `No skills in ${house} yet`}</span>
            <p className="hint">A skill is a folder with a SKILL.md.</p>
            {error && <p className="error">{error}</p>}
            <button className="btn primary" onClick={() => setAdding({})}>
              + New skill
            </button>
          </div>
        ) : (
          <div className="skills">
            <nav className="skills-nav" aria-label="Skills">
              <ul>
                {skills.map((skill) => {
                  const open_ = !shownBuiltin && skill.name === currentSkill;
                  return (
                    <li key={skill.name} className={open_ ? "skill open" : "skill"}>
                      <button
                        type="button"
                        className="skill-head"
                        aria-expanded={open_}
                        disabled={busy}
                        onClick={() => {
                          if (open_) return;
                          // Back from a built-in to the file still open in this skill (its edits kept), or its first.
                          const first = skill.name === currentSkill ? file : skill.files.find(({ kind }) => kind === "file");
                          if (skill.name === currentSkill) setShownBuiltin(undefined);
                          else if (first) void open(first.path);
                        }}
                      >
                        <span className="skill-name">
                          {skill.name}
                          {sharedNames?.has(skill.name) && <span className="tag" title={`${house} has a shared skill by this name too`}>also shared</span>}
                        </span>
                        <span className="skill-description">{descriptions[skill.name] || (skill.files.some(({ path }) => path === `${skill.name}/SKILL.md`) ? "" : "No SKILL.md")}</span>
                      </button>
                      {open_ && (
                        <div className="skill-files">
                          {skill.files.map((entry) => {
                            const name = entry.path.split("/").slice(1).join("/");
                            const slash = name.lastIndexOf("/");
                            const selected = file?.path === entry.path;
                            const Icon = isMarkdown(name) ? FileText : FileCode2;
                            return (
                              <button
                                key={entry.path}
                                type="button"
                                className={selected ? "skill-file selected" : "skill-file"}
                                aria-current={selected ? "true" : undefined}
                                disabled={busy || entry.kind !== "file"}
                                title={entry.kind === "unsupported" ? "Not an ordinary file: not editable here" : entry.path}
                                onClick={() => void open(entry.path)}
                              >
                                <Icon size={14} strokeWidth={1.75} aria-hidden />
                                <span className="ellipsis">
                                  {slash >= 0 && <span className="faint">{name.slice(0, slash + 1)}</span>}
                                  {name.slice(slash + 1)}
                                </span>
                                {(selected ? dirty : hasDraft(scope, entry.path)) && <span className="dot busy" aria-label="Unsaved changes" />}
                                {entry.kind === "unsupported" && <span className="tag">link</span>}
                              </button>
                            );
                          })}
                          <div className="skill-file-actions">
                            <button type="button" className="text-btn plain" onClick={() => setAdding({ skill: skill.name })}>
                              <Plus size={13} strokeWidth={2} aria-hidden /> Add file
                            </button>
                            <button type="button" className="text-btn" onClick={() => removeSkill(skill)}>
                              Delete skill
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {!pet && !scout && builtin.length > 0 && (
                <>
                  <p className="skills-nav-group"><Lock size={12} strokeWidth={2} aria-hidden /> Built-in</p>
                  <ul>
                    {builtin.map((skill) => (
                      <li key={skill.name} className={shownBuiltin?.name === skill.name ? "skill open" : "skill"}>
                        <button type="button" className="skill-head" aria-expanded={shownBuiltin?.name === skill.name} disabled={busy} onClick={() => setShownBuiltin(skill)}>
                          <span className="skill-name">{skill.name}</span>
                          <span className="skill-description">{skill.description}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </nav>
            <section className="skills-doc" aria-label="Skill editor">
              {shownBuiltin ? (
                <>
                  <header className="skills-doc-head">
                    <div className="skills-doc-title">
                      <span className="ellipsis">
                        <span className="faint">{shownBuiltin.name} / </span>
                        SKILL.md
                      </span>
                      <span className="skills-doc-state">Read-only</span>
                    </div>
                  </header>
                  <div className="skills-doc-body">
                    <SkillPreview content={shownBuiltin.content} />
                  </div>
                  <footer className="skills-doc-foot">
                    <span>Household's own: every pet has it.</span>
                    <span>Changes with Household's updates.</span>
                  </footer>
                </>
              ) : file ? (
                <>
                  <header className="skills-doc-head">
                    <div className="skills-doc-title">
                      <span className="ellipsis">
                        <span className="faint">{currentSkill} / </span>
                        {fileName}
                      </span>
                      <span className={dirty ? "skills-doc-state unsaved" : "skills-doc-state"}>{busy ? "Working…" : dirty ? "Unsaved" : "Saved"}</span>
                    </div>
                    {markdownFile && (
                      <div className="segmented" role="group" aria-label="View">
                        <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
                          Edit
                        </button>
                        <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
                          Preview
                        </button>
                      </div>
                    )}
                    <button type="button" className="icon-btn small" title="Discard changes and reload" aria-label="Discard changes and reload" disabled={busy || !dirty} onClick={reload}>
                      <RotateCcw size={15} strokeWidth={1.75} aria-hidden />
                    </button>
                    <button type="button" className="icon-btn small danger" title="Delete file" aria-label="Delete file" disabled={busy} onClick={removeFile}>
                      <Trash2 size={15} strokeWidth={1.75} aria-hidden />
                    </button>
                    <button type="button" className="btn primary small" disabled={busy || !dirty} onClick={() => void save()}>
                      Save
                    </button>
                  </header>
                  {error && (
                    <p className="skills-doc-error error" role="alert">
                      {error}
                    </p>
                  )}
                  <div className="skills-doc-body">
                    {preview && markdownFile ? <SkillPreview content={content} /> : <MarkdownEditor key={file.path} value={content} onChange={edit} onSave={() => void save()} markdownFile={markdownFile} />}
                  </div>
                  <footer className="skills-doc-foot">
                    <span>
                      <kbd>⌘</kbd>
                      <kbd>S</kbd> saves
                    </span>
                    <span>Pets see a new skill from their next session.</span>
                  </footer>
                </>
              ) : (
                <div className="skills-doc-empty">
                  {error ? <p className="error">{error}</p> : <p className="hint">Choose a skill to open its files.</p>}
                </div>
              )}
            </section>
          </div>
        )}
      </Section>
      {adding && <AddSkillDialog save={files.save} skill={adding.skill} taken={entries.map(({ path }) => path)} onClose={() => setAdding(undefined)} onCreated={created} />}
      {dialog.element}
    </>
  );
  return pet || scout ? (
    body
  ) : (
    <Page
      title="Shared Skills"
      actions={
        <button className="btn primary" onClick={() => setAdding({})}>
          + New skill
        </button>
      }
    >
      {body}
      {!loading && skills.length === 0 && <BuiltinSkills skills={builtin} />}
    </Page>
  );
}

/**
 * A new skill (its name and when to use it: a SKILL.md with that frontmatter), or, given `skill`, a new file in it
 * by its path there (`scripts/check.sh`).
 */
function AddSkillDialog({ save, skill, taken, onClose, onCreated }: { save: (path: string, content: string, revision: string | null) => Promise<SkillFile>; skill?: string; taken: string[]; onClose: () => void; onCreated: (path: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const trimmed = name.trim();
  const path = skill ? `${skill}/${trimmed.replace(/^\/+/, "")}` : `${trimmed}/SKILL.md`;
  const problem = !trimmed
    ? undefined
    : skill
      ? taken.includes(path)
        ? "There is a file by that name already."
        : undefined
      : !SKILL_NAME.test(trimmed)
        ? "Lowercase letters, digits and -; start with a letter or digit."
        : trimmed.startsWith("household-")
          ? "Names starting with household- are Household's own."
        : taken.includes(trimmed)
          ? "There is a skill by that name already."
          : undefined;
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: skill ? `Add a file to ${skill}` : "New skill",
        confirmLabel: skill ? "Add file" : "Create skill",
        onConfirm: async () => {
          if (!trimmed) throw new Error(skill ? "Name the file." : "Name the skill.");
          if (problem) return "stay"; // said at its field
          const initial = skill
            ? ""
            : `---\nname: ${trimmed}\ndescription: ${JSON.stringify(description.trim() || "Describe when a pet should use this skill.")}\n---\n\n# ${trimmed}\n\nWrite the instructions here.\n`;
          await save(path, initial, null);
          await onCreated(path);
        },
        children: skill ? (
          <TextField label="File" mono value={name} onChange={setName} placeholder="scripts/check.sh" hint={`Path inside ${skill}; folders are created.`} error={problem} />
        ) : (
          <>
            <TextField label="Name" mono value={name} onChange={(value) => setName(value.toLowerCase().replace(/\s+/g, "-"))} placeholder="code-review" maxLength={64} hint="The skill's folder and name." error={problem} />
            <TextField label="When to use it" value={description} onChange={setDescription} placeholder="Review a diff for bugs before merging" hint="Pets read this to decide when to use it." />
          </>
        ),
      }}
    />
  );
}

/**
 * Household's own skills, for a house with none of its own (no workspace to list them in): every pet has them,
 * nobody edits them here (they change with Household). A row opens its text below the list.
 */
export function BuiltinSkills({ skills }: { skills: BuiltinSkill[] }) {
  const [open, setOpen] = useState<string>();
  if (!skills.length) return null;
  const shown = skills.find((skill) => skill.name === open);
  return (
    <Section width="wide" title="Built-in" hint="Household's own: every pet has them, read-only.">
      <List columns="minmax(0, 1fr) auto">
        {skills.map((skill) => (
          <ListRow key={skill.name} actions={<button type="button" className="btn small" aria-expanded={open === skill.name} onClick={() => setOpen(open === skill.name ? undefined : skill.name)}>{open === skill.name ? "Hide" : "View"}</button>}>
            <Cell>
              <span className="cell-lines">
                <span className="strong mono ellipsis">{skill.name}</span>
                <span className="hint">{skill.description}</span>
              </span>
            </Cell>
          </ListRow>
        ))}
      </List>
      {shown && <div className="builtin-skill"><SkillPreview content={shown.content} /></div>}
    </Section>
  );
}
