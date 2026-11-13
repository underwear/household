/** Rebuild the published doc pages from their reviewed Markdown sources (docs/*.md), with one shared navigation. */
const template = await Bun.file("landing/docs/index.html").text();
const pages = [
  { slug: "start", source: "docs/start.md", title: "Quick start", heading: "Quick start", crumb: "Getting started", description: "Install Household, run house onboard and house start, then write to your first bot." },
  { slug: "bots", source: "docs/bots.md", title: "Bots", heading: "Bots", crumb: "Bots", description: "What a bot is — an assistant powered by a Claude Code or Codex harness in its own microVM that lives in your messenger — how it differs from sideworkers and scouts, and every tab of its page." },
  { slug: "resources", source: "docs/resources.md", title: "Workspace resources", heading: "Workspace resources", crumb: "Operating", description: "One CPU/RAM budget for pets, scouts and sideworkers, with reservations, bot-selected VM sizes and YAML configuration." },
  { slug: "sideworkers", source: "docs/sideworkers.md", title: "Sideworkers", heading: "Sideworkers", crumb: "Bots", description: "Extra assistants a bot starts for one job, in VMs of their own: coding in another project with its own CLAUDE.md or AGENTS.md, a thread you can talk in, parallel work." },
  { slug: "inboxes", source: "docs/inboxes.md", title: "Inboxes", heading: "Workspace inboxes", crumb: "Sources and delivery", description: "Watch mail, feeds, health checks, alerts, a Telegram bot or your own endpoint and hand new events to your bots. Setup, sources, per-bot switches and the custom HTTP format." },
  { slug: "scouts", source: "docs/scouts.md", title: "Scouts", heading: "Scouts", crumb: "Bots", description: "Specialists your bots call for one task, each in its own VM with only the access you give it: the untrusted internet, production keys, closed networks. Every run waits for your Run." },
  { slug: "previews", source: "docs/previews.md", title: "HTTP previews", heading: "HTTP previews", crumb: "Bots", description: "A bot shows you a web app from its VM by a link: you approve each one, it lives 15 minutes, and you choose who can open it." },
  { slug: "volumes", source: "docs/volumes.md", title: "Shared folders", heading: "Shared folders (volumes)", crumb: "Bots", description: "Share folders of your computer with bots at /volumes/<name>, read-only or read-write; bots can ask for one and you approve it in the chat." },
  { slug: "mcp", source: "docs/mcp.md", title: "MCP servers", heading: "Adding MCP servers", crumb: "Bots", description: "Give a bot any MCP server: ask it, and it adds the server to its own Claude Code or Codex, with the hosts and keys you approve." },
  { slug: "backup", source: "docs/backup.md", title: "Back up and move", heading: "Back up and move Household", crumb: "Operating", description: "Save every workspace and bot into one file with house export, restore it with house import, or move Household to another machine." },
];
const WARNING = '<svg class="warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Warning" role="img"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
const nav = (current: string) =>
  `<nav class="side" aria-label="Docs"><h3>Household</h3><ul><li><a href="../">Overview</a></li>${pages.map(p => p.slug === current ? `<li><a href="./" aria-current="page">${p.title}</a></li>` : `<li><a href="../${p.slug}/">${p.title}</a></li>`).join("")}</ul></nav>`;
for (const page of pages) {
  const markdown = await Bun.file(page.source).text();
  const headings: { id: string; title: string }[] = [];
  const content = Bun.markdown.html(markdown).replace(/<h2>(.*?)<\/h2>/g, (_match, title: string) => {
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    headings.push({ id, title });
    return `<h2 id="${id}">${title}</h2>`;
  });
  let html = template
    .replace(/Household overview/g, page.heading)
    .replace("<title>Overview — Household docs</title>", `<title>${page.title} — Household docs</title>`)
    .replace('content="https://agents-household.dev/docs/"', `content="https://agents-household.dev/docs/${page.slug}/"`)
    .replace('href="../favicon.svg"', 'href="../../favicon.svg"')
    .replace('class="brand" href="../"', 'class="brand" href="../../"')
    .replace(/<nav class="side"[\s\S]*?<\/nav>/, nav(page.slug))
    .replace(/<article>[\s\S]*?<\/article>/, `<article><p class="crumb">${page.crumb}</p>${content}</article>`)
    .replace(/<nav class="toc"[\s\S]*?<\/nav>/, headings.length ? `<nav class="toc" aria-label="On this page"><h3>On this page</h3><ul>${headings.map(h => `<li><a href="#${h.id}">${h.title}</a></li>`).join("")}</ul></nav>` : `<nav class="toc" aria-hidden="true"></nav>`)
    .replace('</style>', 'pre { overflow-x: auto; padding: 18px; background: var(--tile); border-radius: 10px; font: 13px/1.6 var(--mono); } article { min-width: 0; } article a { overflow-wrap: anywhere; } td { overflow-wrap: break-word; } td:first-child { white-space: nowrap; } table { display: block; overflow-x: auto; } blockquote { margin: 0 0 12px; padding: 2px 16px; border-left: 3px solid var(--tile); } blockquote p { margin: 0; } svg.warn { width: 1.05em; height: 1.05em; vertical-align: -0.17em; margin-right: 0.25em; color: #b45309; } details { display: block; margin: -8px 0 18px 19px; } details > summary { display: block; width: fit-content; cursor: pointer; list-style: none; font: 400 13px/1.5 var(--font-sans); color: var(--muted); text-decoration: underline dotted; text-underline-offset: 3px; } details > summary::-webkit-details-marker { display: none; } details > summary:hover, details[open] > summary { color: var(--fg); text-decoration-style: solid; } details[open] { padding-left: 14px; border-left: 2px solid var(--line); } details[open] > summary + * { margin-top: 10px; } details > :last-child { margin-bottom: 0; }\n</style>');
  html = html.replace(/(<meta name="description" content=")[^"]*/, `$1${page.description}`);
  // A warning sign in the Markdown (readable on GitHub) is Lucide's triangle-alert on the site, as in the admin.
  html = html.replaceAll("⚠️", WARNING);
  await Bun.write(`landing/docs/${page.slug}/index.html`, html);
  console.log(`Built landing/docs/${page.slug}/index.html`);
}

// Keep published bookmarks working after the terminology change.
await Bun.write("landing/docs/pets/index.html", `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bots — Household docs</title><link rel="canonical" href="https://agents-household.dev/docs/bots/"><meta http-equiv="refresh" content="0; url=../bots/"></head><body><p>The documentation has moved to <a href="../bots/">Bots</a>.</p><script>location.replace("../bots/" + location.search + location.hash.replaceAll("pet", "bot"));</script></body></html>
`);
