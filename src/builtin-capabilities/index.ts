import type { CapabilityDefinition } from "../core/scouts";

/**
 * Starting points for a house's capabilities: an install script (fetching software at run time, nothing vendored
 * here), a network and a description. Once created from one, a capability is the owner's like any other.
 */
export const CAPABILITY_TEMPLATES: (Omit<CapabilityDefinition, "keys"> & { label: string })[] = [
  {
    name: "browser", label: "Browser (Playwright)",
    description: "A headless Chromium driven by Playwright: sites without an API, forms, tickets, screenshots.",
    install: "apt-get update -qq\napt-get install -y -qq nodejs npm\nnpm install -g playwright\nplaywright install --with-deps chromium\n",
    network: { any: true, allow: [] },
  },
  {
    name: "media", label: "Media (yt-dlp, ffmpeg)",
    description: "Download video and audio with yt-dlp; convert and cut with ffmpeg.",
    install: "apt-get update -qq\napt-get install -y -qq ffmpeg python3-pip\npip install --break-system-packages -q yt-dlp\n",
    network: { any: true, allow: [] },
  },
  {
    name: "dev", label: "Developer tools",
    description: "git, Node.js, Python and the usual command-line tools, to clone and inspect repositories.",
    install: "apt-get update -qq\napt-get install -y -qq git curl jq python3 python3-pip nodejs npm\n",
    network: { any: true, allow: [] },
  },
  {
    name: "heroku-cli", label: "Heroku CLI",
    description: "The Heroku CLI: logs, config, releases, pg:psql. Give it a key with HEROKU_API_KEY.",
    install: "curl -fsSL https://cli-assets.heroku.com/install.sh | sh\n",
    network: { any: false, allow: [{ host: "api.heroku.com", port: 443 }, { host: "cli-assets.heroku.com", port: 443 }] },
  },
  {
    name: "psql", label: "PostgreSQL client",
    description: "psql for one database. Give it a connection string as a key (DATABASE_URL) and the database's host and port.",
    install: "apt-get update -qq\napt-get install -y -qq postgresql-client\n",
    // apt's mirror too: with a host list, the install script reaches only these hosts.
    network: { any: false, allow: [{ host: "deb.debian.org", port: 80 }, { host: "deb.debian.org", port: 443 }, { host: "db.example.com", port: 5432 }] },
  },
];

/** The scout a house gets when it turns scouts on: the three open tools, called freely by its pets. */
export const GENERAL_SCOUT = {
  name: "general", title: "General", emoji: "🧭", instructions: "",
  description: "General-purpose helper on the open internet: browse and buy on sites without an API, download media, inspect repositories, research. No keys of its own.",
  capabilities: ["browser", "media", "dev"],
};
