/** Rebuild the published doc pages from their reviewed Markdown sources (docs/*.md), with one shared navigation. */
// The overview is itself built from this template: drop what a build added to it, so builds don't pile it up.
const PAGE_STYLE = 'pre { overflow-x: auto; padding: 18px; background: var(--tile); border-radius: 10px; font: 13px/1.6 var(--mono); } article { min-width: 0; } article a { overflow-wrap: anywhere; } td { overflow-wrap: break-word; } td:first-child { white-space: nowrap; } table { display: block; overflow-x: auto; } blockquote { margin: 0 0 12px; padding: 2px 16px; border-left: 3px solid var(--tile); } blockquote p { margin: 0; } svg.warn { width: 1.05em; height: 1.05em; vertical-align: -0.17em; margin-right: 0.25em; color: #b45309; } details { display: block; margin: -8px 0 18px 19px; } details > summary { display: block; width: fit-content; cursor: pointer; list-style: none; font: 400 13px/1.5 var(--font-sans); color: var(--muted); text-decoration: underline dotted; text-underline-offset: 3px; } details > summary::-webkit-details-marker { display: none; } details > summary:hover, details[open] > summary { color: var(--fg); text-decoration-style: solid; } details[open] { padding-left: 14px; border-left: 2px solid var(--line); } details[open] > summary + * { margin-top: 10px; } details > :last-child { margin-bottom: 0; }';
const template = (await Bun.file("landing/docs/index.html").text()).replaceAll(`${PAGE_STYLE}\n`, "");
/**
 * The docs, grouped as the side navigation shows them: by what the reader wants to do, not by how Household is built.
 * Titles stay generic ("Connectors", "Channels") so a new connector or messenger is a section of a page, not a new item.
 * `slug` "" is the overview, at /docs/ itself.
 */
const groups: { title: string; pages: { slug: string; source: string; title: string; heading: string; description: string }[] }[] = [
  { title: "Getting started", pages: [
    { slug: "", source: "docs/overview.md", title: "Overview", heading: "Household overview", description: "Your own AI assistants, each a coding-agent harness such as Claude Code or Codex in its own microVM on your machine, that you talk to in your messenger: the idea, how it works and how it keeps your accounts safe." },
    { slug: "start", source: "docs/start.md", title: "Quick start", heading: "Quick start", description: "Install Household, set it up in the web admin or with house onboard, and write to your first bot." },
  ] },
  { title: "Bots", pages: [
    { slug: "bots", source: "docs/bots.md", title: "Bots", heading: "Bots", description: "What a bot is, adding one, and everything on its page: harness, instructions, channels, scheduled tasks, skills, memory, resources and more." },
    { slug: "keys", source: "docs/keys.md", title: "Keys", heading: "Keys", description: "What your bots run on: a Claude or ChatGPT subscription you sign in to, or an API key. The bots never see it." },
    { slug: "instructions", source: "docs/instructions.md", title: "Instructions, skills and memory", heading: "Instructions, skills and memory", description: "Tell a bot who it is and how to work, give it skills, and see what it remembers." },
    { slug: "sideworkers", source: "docs/sideworkers.md", title: "Sideworkers", heading: "Sideworkers", description: "Extra assistants a bot starts for one job, in VMs of their own: coding in another project, a thread you can talk in, parallel work." },
    { slug: "scouts", source: "docs/scouts.md", title: "Scouts", heading: "Scouts", description: "Specialists your bots call for one task, each in its own VM with only the access you give it. Every run waits for your approval." },
  ] },
  { title: "Talking to bots", pages: [
    { slug: "channels", source: "docs/channels.md", title: "Channels", heading: "Channels", description: "Connect a messenger to a workspace, choose who may talk to its bots, and put bots in it." },
  ] },
  { title: "What bots can reach", pages: [
    { slug: "connectors", source: "docs/connectors.md", title: "Connectors", heading: "Connectors", description: "Let bots use your accounts (mail, documents, calendars, chats, tasks) with the access you choose for each account and each bot." },
    { slug: "network", source: "docs/network.md", title: "Network and secrets", heading: "Network and secrets", description: "Which hosts bots may reach, temporary access when they ask, and secrets they use without ever seeing them." },
    { slug: "volumes", source: "docs/volumes.md", title: "Shared folders", heading: "Shared folders", description: "Share folders of your computer with bots, read-only or writable, per bot." },
    { slug: "previews", source: "docs/previews.md", title: "Previews", heading: "Previews", description: "A bot shows you a web app it runs by a link: you approve each one, and choose who can open it." },
    { slug: "mcp", source: "docs/mcp.md", title: "MCP servers", heading: "MCP servers", description: "Give a bot any MCP server: ask it, and it adds the server to its own setup." },
  ] },
  { title: "Automation", pages: [
    { slug: "inboxes", source: "docs/inboxes.md", title: "Inboxes", heading: "Inboxes", description: "Watch mail, feeds, health checks, alerts and your own endpoints, and hand new events to your bots." },
    { slug: "schedules", source: "docs/schedules.md", title: "Scheduled tasks", heading: "Scheduled tasks", description: "Have a bot do something on a schedule: every morning, on weekdays, once next Friday." },
  ] },
  { title: "Running Household", pages: [
    { slug: "resources", source: "docs/resources.md", title: "Resources", heading: "Resources", description: "How much CPU and memory each workspace and bot gets, and how scouts and sideworkers share it." },
    { slug: "backup", source: "docs/backup.md", title: "Back up and move", heading: "Back up and move", description: "Save every workspace and bot into one file, restore it, or move Household to another machine." },
    { slug: "operating", source: "docs/operating.md", title: "Updates and troubleshooting", heading: "Updates and troubleshooting", description: "Update Household, check that it runs, read its logs, and fix the problems people meet most." },
  ] },
];
const pages = groups.flatMap((g) => g.pages.map((p) => ({ ...p, crumb: g.title })));
/** Pages that moved: their old address sends the reader on (with the old anchor, or a new one). */
const moved: { from: string; to: string; hash?: string; title: string }[] = [
  { from: "pets", to: "bots", title: "Bots" },
  { from: "mail-connector", to: "connectors", title: "Connectors" },
];
const WARNING = '<svg class="warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Warning" role="img"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
/** The side navigation, a list per group; links are relative to the page (the overview is one level up from the rest). */
const nav = (current: string) => {
  const href = (slug: string) => (current === "" ? (slug ? `${slug}/` : "./") : slug ? `../${slug}/` : "../");
  return `<nav class="side" aria-label="Docs">${groups.map((g) => `<h3>${g.title}</h3><ul>${g.pages.map((p) => `<li><a href="${p.slug === current ? "./" : href(p.slug)}"${p.slug === current ? ' aria-current="page"' : ""}>${p.title}</a></li>`).join("")}</ul>`).join("")}</nav>`;
};
for (const page of pages) {
  const markdown = await Bun.file(page.source).text();
  const headings: { id: string; title: string }[] = [];
  const content = Bun.markdown.html(markdown).replace(/<h2>(.*?)<\/h2>/g, (_match, title: string) => {
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    headings.push({ id, title });
    return `<h2 id="${id}">${title}</h2>`;
  });
  // Sub-sections get anchors too (a page may link to one), but stay out of the table of contents.
  const anchored = content.replace(/<h3>(.*?)<\/h3>/g, (_match, title: string) => `<h3 id="${title.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}">${title}</h3>`);
  const top = page.slug === "";
  // The first paragraph under the title is the page's lead.
  const article = anchored.replace(/(<\/h1>\s*)<p>/, '$1<p class="lead">');
  let html = template
    .replace(/Household overview/g, page.heading)
    .replace("<title>Overview — Household docs</title>", `<title>${page.title} — Household docs</title>`)
    .replace('content="https://agents-household.dev/docs/"', `content="https://agents-household.dev/docs/${top ? "" : `${page.slug}/`}"`)
    .replace('href="../favicon.svg"', top ? 'href="../favicon.svg"' : 'href="../../favicon.svg"')
    .replace('class="brand" href="../"', top ? 'class="brand" href="../"' : 'class="brand" href="../../"')
    .replace(/<nav class="side"[\s\S]*?<\/nav>/, nav(page.slug))
    .replace(/<article>[\s\S]*?<\/article>/, `<article><p class="crumb">${page.crumb}</p>${article}</article>`)
    .replace(/<nav class="toc"[\s\S]*?<\/nav>/, headings.length ? `<nav class="toc" aria-label="On this page"><h3>On this page</h3><ul>${headings.map(h => `<li><a href="#${h.id}">${h.title}</a></li>`).join("")}</ul></nav>` : `<nav class="toc" aria-hidden="true"></nav>`)
    .replace('</style>', `${PAGE_STYLE}\n</style>`)
  html = html.replace(/(<meta name="description" content=")[^"]*/, `$1${page.description}`);
  // The page's own address on the main domain, so a copy reached another way (a mirror, a query string) counts as this one.
  html = html.replace(/\n\s*<link rel="canonical"[^>]*>/, "").replace(/(\n(\s*)<meta property="og:url" content="([^"]*)">)/, `$1\n$2<link rel="canonical" href="$3">`);
  // A warning sign in the Markdown (readable on GitHub) is Lucide's triangle-alert on the site, as in the admin.
  html = html.replaceAll("⚠️", WARNING);
  const out = top ? "landing/docs/index.html" : `landing/docs/${page.slug}/index.html`;
  await Bun.write(out, html);
  console.log(`Built ${out}`);
}

// Keep published bookmarks working: an old page sends the reader to where its content is now.
for (const page of moved) {
  const to = `../${page.to}/`;
  const hash = page.hash ? JSON.stringify(page.hash) : `location.hash${page.from === "pets" ? '.replaceAll("pet", "bot")' : ""}`;
  await Bun.write(`landing/docs/${page.from}/index.html`, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${page.title} — Household docs</title><link rel="canonical" href="https://agents-household.dev/docs/${page.to}/"><meta http-equiv="refresh" content="0; url=${to}${page.hash ?? ""}"></head><body><p>The documentation has moved to <a href="${to}${page.hash ?? ""}">${page.title}</a>.</p><script>location.replace("${to}" + location.search + (${hash} || ""));</script></body></html>
`);
  console.log(`Redirect landing/docs/${page.from}/ → ${to}${page.hash ?? ""}`);
}
