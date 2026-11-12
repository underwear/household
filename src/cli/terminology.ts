/** Public CLI vocabulary, normalized to the existing config/control contract. */
const FLAGS: Record<string, string> = {
  harness: "agent", bot: "pet", bots: "pets", workspace: "house", workspaces: "houses",
};

export function normalizeCliArgs(argv: string[]): string[] {
  let positional = false;
  let value = false;
  return argv.map((arg) => {
    if (positional) return arg;
    if (value) { value = false; return arg; }
    if (arg === "--") { positional = true; return arg; }
    const match = /^--([^=]+)(=.*)?$/.exec(arg);
    // Every option except these booleans consumes its next token, even when it starts with --.
    const booleans = ["help", "version", "force", "local", "no-open", "now", "deleted", "follow", "problems", "json", "wait", "link"];
    if (match && match[2] === undefined && !booleans.includes(match[1]!)) value = true;
    if (["-n"].includes(arg)) value = true;
    return match && FLAGS[match[1]!] ? `--${FLAGS[match[1]!]}${match[2] ?? ""}` : arg;
  });
}

export function normalizeCommand(command: string | undefined, args: string[]): { command: string | undefined; args: string[] } {
  if (command === "bot") return { command: "pet", args };
  if ((command === "workspace" || command === "house") && ["create", "add", "show", "delete", "rm", "allow", "disallow", "revoke"].includes(args[0] ?? "")) {
    const [verb, ...rest] = args;
    return { command: verb === "add" ? "create" : verb === "rm" ? "delete" : verb, args: rest };
  }
  return { command, args };
}
