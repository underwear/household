import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BuiltinSkills, SkillPreview, SkillsPage, frontmatterOf } from "./components/skills";
import { routeOf } from "./router";

test("Skills belongs to the workspace navigation; a new skill is a button in the page's head", () => {
  expect(routeOf("/workspaces/work/skills")).toEqual({ page: "workspace", name: "work", tab: "skills" });
  const html = renderToStaticMarkup(<SkillsPage house="work" notify={() => {}} />);
  expect(html).toContain("Shared by every bot in work");
  expect(html).toContain('<button class="btn primary">+ New skill</button>');
  expect(html).toContain("Loading skills…"); // before the list comes
});

test("a skill's frontmatter: its fields (quotes off), and the body after it", () => {
  const { fields, body } = frontmatterOf('---\nname: review\ndescription: "Check a diff: bugs first"\n---\n\n# Review\n');
  expect(fields).toEqual({ name: "review", description: "Check a diff: bugs first" });
  expect(body).toBe("\n# Review\n");
  expect(frontmatterOf("# No frontmatter\n")).toEqual({ fields: {}, body: "# No frontmatter\n" });
});

test("Markdown preview: the frontmatter as its header, formatting without active HTML, remote images or script links", () => {
  const head = renderToStaticMarkup(<SkillPreview content={"---\nname: review\ndescription: Check a diff\n---\n# Title"} />);
  expect(head).toContain('<header class="skill-preview-head"><span class="skill-preview-name">review</span><p>Check a diff</p></header>');
  expect(head).not.toContain("name: review"); // not as text
  const html = renderToStaticMarkup(<SkillPreview content={'# Title\n\n**bold**\n\n<script>alert(1)</script>\n\n![pixel](https://evil.test/track)\n\n[click](javascript:alert(1))'} />);
  expect(html).toContain("<h1>Title</h1>");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("https://evil.test");
});

test("Household's own skills sit under the workspace's, read-only: a row opens its text, nothing edits it", () => {
  const html = renderToStaticMarkup(<BuiltinSkills skills={[{ name: "household-network", description: "Reach a blocked host.", content: "---\nname: household-network\ndescription: Reach a blocked host.\n---\n\n# Network\n" }]} />);
  expect(html).toContain('<h2 class="h2">Built-in</h2>');
  expect(html).toContain("household-network");
  expect(html).toContain("Reach a blocked host.");
  expect(html).toContain('aria-expanded="false">View</button>');
  expect(html).not.toContain("Save");
  expect(renderToStaticMarkup(<BuiltinSkills skills={[]} />)).toBe(""); // none: nothing at all
});
