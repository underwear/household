/** Rebuild the published inbox reference from its reviewed Markdown source. */
const template = await Bun.file("landing/docs/index.html").text();
const markdown = await Bun.file("docs/inboxes.md").text();
const headings: { id: string; title: string }[] = [];
const content = Bun.markdown.html(markdown).replace(/<h2>(.*?)<\/h2>/g, (_match, title: string) => {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  headings.push({ id, title });
  return `<h2 id="${id}">${title}</h2>`;
});
let page = template
  .replace(/Household overview/g, "House inboxes")
  .replace("<title>Overview — Household docs</title>", "<title>Inboxes — Household docs</title>")
  .replace('content="https://agents-household.dev/docs/"', 'content="https://agents-household.dev/docs/inboxes/"')
  .replace('href="../favicon.svg"', 'href="../../favicon.svg"')
  .replace('class="brand" href="../"', 'class="brand" href="../../"')
  .replace(/<nav class="side"[\s\S]*?<\/nav>/, `<nav class="side" aria-label="Docs"><h3>Household</h3><ul><li><a href="../">Overview</a></li><li><a href="./" aria-current="page">Inboxes</a></li><li><a href="../../#start">Quick start</a></li></ul></nav>`)
  .replace(/<article>[\s\S]*?<\/article>/, `<article><p class="crumb">Sources and delivery</p>${content}</article>`)
  .replace(/<nav class="toc"[\s\S]*?<\/nav>/, `<nav class="toc" aria-label="On this page"><h3>On this page</h3><ul>${headings.map(h => `<li><a href="#${h.id}">${h.title}</a></li>`).join("")}</ul></nav>`)
  .replace('</style>', 'pre { overflow-x: auto; padding: 18px; background: var(--tile); border-radius: 10px; font: 13px/1.6 var(--mono); } article { min-width: 0; } article a, td { overflow-wrap: anywhere; } table { display: block; overflow-x: auto; }\n</style>');
page = page.replace(/(<meta name="description" content=")[^"]*/, '$1Watch mail, feeds, health checks, alerts, a Telegram bot or your own endpoint and hand new events to your pets. Setup, sources, per-pet switches and the custom HTTP format.');
await Bun.write("landing/docs/inboxes/index.html", page);
console.log("Built landing/docs/inboxes/index.html");
