import { createInterface } from "node:readline/promises";

/** A conversation on the terminal: what `house onboard` says and asks. Faked in tests. */
export interface Terminal {
  say(text?: string): void;
  /** A line typed by the user, trimmed. */
  ask(question: string): Promise<string>;
  /** A line typed without echo (a key, a token). */
  secret(question: string): Promise<string>;
}

const BOLD = "\x1b[1m", DIM = "\x1b[2m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RESET = "\x1b[0m";
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (color ? `${code}${text}${RESET}` : text);
export const bold = paint(BOLD), dim = paint(DIM), green = paint(GREEN), yellow = paint(YELLOW);

/** The real terminal: cooked-mode lines, so the terminal edits them; secrets with echo off. */
export function consoleTerminal(): Terminal {
  const line = async (question: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    process.stdout.write(question);
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        rl.once("line", resolve);
        rl.once("close", () => reject(new Error("input closed")));
      });
      return answer.trim();
    } finally {
      rl.close();
    }
  };
  return {
    say: (text = "") => console.log(text),
    ask: line,
    secret: (question) => hiddenLine(question),
  };
}

/**
 * A line read in raw mode: nothing echoed, and no length limit (a terminal's own line editing stops at 1024 bytes
 * on macOS, short of a pasted Codex login). Backspace edits, Ctrl-C quits, Enter ends it.
 */
function hiddenLine(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let text = "";
    const done = (exit?: number) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write(text ? dim(` (${text.length} characters)\n`) : "\n");
      if (exit !== undefined) process.exit(exit);
      resolve(text.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8").replace(/\x1b\[20[01]~/g, "")) { // bracketed-paste markers
        if (char === "\r" || char === "\n") return done();
        if (char === "\x03") return done(130);
        if (char === "\x04") return done();
        if (char === "\x7f" || char === "\b") text = text.slice(0, -1);
        else if (char >= " ") text += char;
      }
    };
    stdin.on("data", onData);
  });
}

/** A question with a default shown in brackets; Enter takes it. */
export async function askOr(terminal: Terminal, question: string, fallback: string): Promise<string> {
  return (await terminal.ask(`${question} ${dim(`[${fallback}]`)} `)) || fallback;
}

/** Yes or no; Enter takes the default. */
export async function confirm(terminal: Terminal, question: string, fallback = true): Promise<boolean> {
  for (;;) {
    const answer = (await terminal.ask(`${question} ${dim(fallback ? "[Y/n]" : "[y/N]")} `)).toLowerCase();
    if (!answer) return fallback;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
  }
}

/** One of numbered options, numbered on across the sections their `heading`s start; Enter takes the first. */
export async function choose<T extends string>(terminal: Terminal, question: string, options: { value: T; label: string; heading?: string }[]): Promise<T> {
  terminal.say(question);
  options.forEach(({ label, heading }, index) => {
    if (heading) terminal.say(dim(heading));
    terminal.say(`  ${bold(String(index + 1))}) ${label}`);
  });
  for (;;) {
    const answer = await terminal.ask(`${dim("[1]")} `);
    const index = answer ? Number(answer) - 1 : 0;
    if (Number.isInteger(index) && options[index]) return options[index].value;
  }
}

/** Asks until `accept` takes an answer; what it throws is said, and asked again. */
export async function until<T>(terminal: Terminal, read: () => Promise<string>, accept: (answer: string) => Promise<T> | T): Promise<T> {
  for (;;) {
    try {
      return await accept(await read());
    } catch (error) {
      terminal.say(yellow(`  ${(error as Error).message}`));
    }
  }
}
