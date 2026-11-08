import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Globe, Pause, Play } from "lucide-react";
import { api, type LogKind, type LogLine, type LogPage, type PetLogSource } from "../api";
import { focusPage } from "./layout";
import { useFocusTrap } from "./focus-trap";
import { every, followLog, type LogFollow } from "./log-follow";

/** At most this many lines stay on screen; the oldest go first. */
const KEEP = 2000;
/** At most this much of a VM log's text stays on screen, from a line's start. */
const KEEP_TEXT = 512 * 1024;

// Made once: a formatter costs far more to make than to use, and a log formats thousands of times.
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** «17:26:12», with the day before it when it is not today. */
export function logTime(at: string, now = new Date()): string {
  const date = new Date(at);
  const time = TIME.format(date);
  if (date.toDateString() === now.toDateString()) return time;
  const parts = DAY.formatToParts(date);
  return `${parts.find((part) => part.type === "day")?.value} ${parts.find((part) => part.type === "month")?.value} ${time}`;
}

/** Lines a follow-up read left out (more came than it takes): a mark where they were. */
interface Gap {
  id: string;
  skipped: number;
}
type Row = LogLine | Gap;

/** The rows on screen once a follow-up page came: the newest KEEP, each line keeping its id (its key) as it goes. */
export function appendPage(rows: Row[], page: LogPage, keep = KEEP): Row[] {
  if (!page.lines.length && !page.skipped) return rows;
  const gap = page.skipped ? [{ id: `gap-${page.lines[0]?.id ?? page.cursor}`, skipped: page.skipped }] : [];
  return [...rows, ...gap, ...page.lines].slice(-keep);
}

/** The end of a text, at most `max` characters, from a line's start. */
export function lastText(text: string, max = KEEP_TEXT): string {
  if (text.length <= max) return text;
  const end = text.slice(-max);
  const newline = end.indexOf("\n");
  return newline === -1 ? end : end.slice(newline + 1);
}

/**
 * Follows a log (see followLog) while `enabled`: anew when `key` (what it reads) changes, paused while not `live`.
 * Returns the last read's error, if it failed.
 */
function useLogFollow<P extends { cursor: string }>(
  key: string,
  { enabled = true, live, everyMs }: { enabled?: boolean; live: boolean; everyMs: number },
  read: (after: string | undefined, signal: AbortSignal) => Promise<P>,
  update: (page: P, first: boolean) => void,
): string | undefined {
  const [error, setError] = useState<string>();
  const follow = useRef<LogFollow>(undefined);
  const liveNow = useRef(live);
  useEffect(() => {
    if (!enabled) return;
    setError(undefined);
    const started = followLog(read, (page, first) => { setError(undefined); update(page, first); }, setError, { live: liveNow.current, schedule: every(everyMs) });
    follow.current = started;
    return () => started.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is what `read` reads
  }, [key, enabled]);
  useEffect(() => {
    liveNow.current = live;
    follow.current?.setLive(live);
  }, [live]);
  return error;
}

/** Keeps a scroller at its bottom while new lines come, unless someone scrolled up to read. */
function useStickToBottom<T extends HTMLElement>(dependency: unknown) {
  const ref = useRef<T>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [dependency]);
  const onScroll = () => {
    const element = ref.current;
    if (element) atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  };
  return { ref, onScroll };
}

/** Live or paused: a button that says which, and switches. */
function LiveToggle({ live, onChange }: { live: boolean; onChange: (live: boolean) => void }) {
  return (
    <button type="button" className="btn small log-live" aria-pressed={live} onClick={() => onChange(!live)} title={live ? "Pause: stop reading new lines" : "Follow new lines as they come"}>
      {live ? <Pause size={12} strokeWidth={2} aria-hidden /> : <Play size={12} strokeWidth={2} aria-hidden />}
      {live ? <><span className="dot idle" /> Live</> : "Paused"}
    </button>
  );
}

/**
 * What Household logged about this pet, newest at the bottom, one line each (a click opens one whole). Its network
 * requests are many and seldom what is looked for: hidden until asked for. Broad investigation belongs in the CLI.
 */
function PetActivity({ house, pet, lead }: { house: string; pet: string; lead: ReactNode }) {
  const [network, setNetwork] = useState(false);
  const [words, setWords] = useState("");
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(true);
  const [rows, setRows] = useState<Row[]>();
  const [searchedFrom, setSearchedFrom] = useState<string>();
  const { ref, onScroll } = useStickToBottom<HTMLDivElement>(rows);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(words.trim()), 300);
    return () => clearTimeout(timer);
  }, [words]);
  const filter = { house, pet, kinds: network ? undefined : (["daemon", "agent"] as LogKind[]), q: query || undefined };
  const key = JSON.stringify(filter);
  useEffect(() => setRows(undefined), [key]);
  const error = useLogFollow(key, { live, everyMs: 2000 },
    (after, signal) => api.logs({ ...filter, ...(after === undefined ? { limit: 300 } : { after, limit: KEEP }) }, signal),
    (page, first) => {
      if (first) setSearchedFrom(page.searchedFrom);
      setRows((current) => (first ? page.lines : appendPage(current ?? [], page)));
    });
  return (
    <>
      <div className="log-filters">
        {lead}
        <input className="control log-search" type="search" aria-label="Search the log" placeholder="Search…" value={words} onChange={(event) => setWords(event.target.value)} />
        <button type="button" className="btn small log-toggle" aria-pressed={network} onClick={() => setNetwork(!network)} title={network ? "Hide its network requests" : "Show its network requests too"}>
          <Globe size={12} strokeWidth={2} aria-hidden />
          Network
        </button>
        <LiveToggle live={live} onChange={setLive} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="log log-lines" ref={ref} onScroll={onScroll} role="log" aria-live="off" aria-label="Pet activity">
        {!rows ? (
          <p className="log-empty">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="log-empty">
            {`${searchedFrom ? `Nothing that fits since ${logTime(searchedFrom)}: older lines were not searched` : "Nothing logged that fits"}${live ? "; new lines show up here as they come." : "."}`}
          </p>
        ) : (
          <>
            {searchedFrom && <p className="log-gap">Searched back to {logTime(searchedFrom)}; older lines were not looked at.</p>}
            {rows.map((row) => ("skipped" in row ? <p key={row.id} className="log-gap">… {row.skipped} more {row.skipped === 1 ? "line" : "lines"} left out</p> : <LogRow key={row.id} line={row} />))}
          </>
        )}
      </div>
    </>
  );
}

/** What an agent's line is, by how event-log.ts begins it: its label, and how loud it reads. */
const AGENT_LINES: [prefix: RegExp, label: string, tone: Tone][] = [
  [/^prompt accepted: /, "Message", "loud"],
  [/^answer: /, "Answer", "loud"],
  [/^turn failed: /, "Failed", "loud"],
  [/^notification: /, "Notice", "plain"],
  [/^tool (?=\S+ (done|failed)\b)/, "Tool", "quiet"],
  [/^tool /, "Tool", "plain"],
  [/^auto reviewer: /, "Review", "plain"],
  [/^dialog /, "Dialog", "plain"],
  [/^session /, "Session", "plain"],
];
type Tone = "loud" | "plain" | "quiet";

/** The context Household puts before a prompt (the clock, the memory): the same every time, so left out of the line. */
const CONTEXT = /<household-(clock|memory)>.*?(<\/household-\1>|$)\s*/g;

/** A line as it reads in the log: a word for what it is, its text without the prefix that said so, and its tone. */
export function logEntry(line: Pick<LogLine, "kind" | "text">): { label: string; text: string; tone: Tone } {
  if (line.kind === "network") return { label: "Network", text: line.text, tone: "quiet" };
  // The log is one pet's already: "pet work/owl: " before its lines says nothing.
  if (line.kind === "daemon") return { label: "Household", text: line.text.replace(/^pet [^:\s]+: /, ""), tone: "plain" };
  const known = AGENT_LINES.find(([prefix]) => prefix.test(line.text));
  if (!known) return { label: "Agent", text: line.text, tone: "plain" };
  const [prefix, label, tone] = known;
  const text = line.text.replace(prefix, "");
  if (label === "Tool") return { label, text: text.replace(/^mcp__household__/, "").replace(/^mcp__([^_]+)__/, "$1 · "), tone };
  if (label !== "Message") return { label, text, tone };
  const prompt = text.replace(CONTEXT, "");
  if (!prompt) return { label, text: "Household context only", tone: "quiet" };
  // A message from Household itself (another pet's, a notice) comes as JSON in a tag: its text is what was said.
  const internal = prompt.match(/^<household-internal>\s*\{"text":"((?:[^"\\]|\\.)*)/);
  return internal ? { label: "Internal", text: internal[1]!.replace(/\\(["\\])/g, "$1").replace(/\\n/g, " "), tone: "plain" } : { label, text: prompt, tone };
}

/** One line of the log: on one line until clicked (or Enter), then whole; the same line object never renders twice. */
const LogRow = memo(function LogRow({ line }: { line: LogLine }) {
  const [open, setOpen] = useState(false);
  const { label, text, tone } = logEntry(line);
  const toggle = () => {
    if (!getSelection()?.isCollapsed) return; // selecting text to copy is not a click on the line
    setOpen(!open);
  };
  return (
    <div className={`log-row ${line.level} ${tone}${open ? " open" : ""}`} tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(event) => event.key === "Enter" && toggle()}>
      <time className="log-time" dateTime={line.at}>{logTime(line.at)}</time>
      <span className={`log-kind ${line.kind}`}>{label}</span>
      <span className="log-text" title={open ? undefined : line.text}>{text}</span>
    </div>
  );
});

const PET_SOURCES: { value: "activity" | PetLogSource; label: string; empty: string }[] = [
  { value: "activity", label: "Activity", empty: "" },
  { value: "setup", label: "Setup", empty: "The setup script has not run in this VM." },
  { value: "onStart", label: "On start", empty: "The on-start script has not run in this VM." },
  { value: "docker", label: "Docker", empty: "There is no Docker log in this VM." },
  { value: "kernel", label: "Kernel", empty: "The kernel log could not be read." },
];

/** A log inside a pet's VM, as text: its last lines, followed every three seconds while Live. */
function PetVmLog({ house, pet, source, enabled, lead }: { house: string; pet: string; source: PetLogSource; enabled: boolean; lead: ReactNode }) {
  const [text, setText] = useState<string>();
  const [missing, setMissing] = useState(false);
  const [live, setLive] = useState(true);
  const { ref, onScroll } = useStickToBottom<HTMLPreElement>(text);
  const error = useLogFollow(`${house}/${pet}/${source}`, { enabled, live, everyMs: 3000 },
    (after, signal) => api.petLog(house, pet, source, after === undefined ? { lines: 500 } : { after }, signal),
    (view, first) => {
      setMissing(view.missing);
      // The text comes byte for byte: a follow-up read can go on in the middle of a line.
      setText((current) => lastText(first || view.restarted ? view.text : (current ?? "") + view.text));
    });
  const empty = PET_SOURCES.find(({ value }) => value === source)!.empty;
  return (
    <>
      <div className="log-filters">
        {lead}
        {source === "kernel" && <span className="hint">dmesg</span>}
        <LiveToggle live={live} onChange={setLive} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!enabled ? (
        <p className="log-empty log">The pet is disabled: its VM is stopped.</p>
      ) : text === undefined && !error ? (
        <p className="log-empty log">Loading…</p>
      ) : missing || !text ? (
        <p className="log-empty log">{missing ? empty : "Empty so far."}</p>
      ) : (
        <pre className="log log-pre" ref={ref} onScroll={onScroll}>{text}</pre>
      )}
    </>
  );
}

/** What Household logged about a pet (Activity), or one of the logs inside its VM, switched at the top. */
export function PetLogs({ house, pet }: { house: string; pet: { name: string; enabled?: boolean } }) {
  const [source, setSource] = useState<"activity" | PetLogSource>("activity");
  const choice = (
    <div className="segmented" role="group" aria-label="Log source">
      {PET_SOURCES.map(({ value, label }) => (
        <button key={value} type="button" aria-pressed={source === value} onClick={() => setSource(value)}>{label}</button>
      ))}
    </div>
  );
  return source === "activity" ? (
    <PetActivity key={`${house}/${pet.name}`} house={house} pet={pet.name} lead={choice} />
  ) : (
    <PetVmLog key={`${house}/${pet.name}/${source}`} house={house} pet={pet.name} source={source} enabled={pet.enabled !== false} lead={choice} />
  );
}

/** A pet's logs over its page, opened from its header beside Console; Escape or Close shuts it. */
export function LogsDialog({ house, pet, title, onClose }: { house: string; pet: { name: string; enabled?: boolean }; title: string; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const pressedOutside = useRef(false);
  const close = useCallback(() => onClose(), [onClose]);
  useFocusTrap(root, true, close);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => {
      opener?.focus();
      if (!opener || document.activeElement !== opener) focusPage();
    };
  }, []);
  return (
    <div className="scrim"
      onPointerDown={(event) => (pressedOutside.current = event.target === event.currentTarget)}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedOutside.current) close();
        pressedOutside.current = false;
      }}>
      <div ref={root} className="dialog panel-dialog" role="dialog" aria-modal="true" aria-label={`${title} logs`} tabIndex={-1}>
        <h2 className="dialog-title">{title} logs</h2>
        <div className="panel-dialog-body">
          <PetLogs house={house} pet={pet} />
        </div>
        <div className="dialog-foot">
          <button ref={closeButton} type="button" className="btn primary" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
