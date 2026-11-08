import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryTree, memoryTree } from "./components/pet-memory";
import { SkillPreview } from "./components/skills";
import { routeOf, petPath } from "./router";

test("memory routes remain per pet; the tree keeps a parent that is a note selectable, once, and leaves core out", () => {
  expect(routeOf(petPath("work", "owl", "memory"))).toEqual({ page: "pet", house: "work", pet: "owl", tab: "memory" });
  const entries = ["core", "projects", "projects.household", "projects.household.deploy", "people.anya"].map((key) => ({ key, revision: 1, updated: "", actor: "pet", deleted: false, excerpt: "" }));
  const nodes = memoryTree(entries);
  expect(nodes.map(({ key }) => key)).toEqual(["projects", "people"]); // core is pinned above the tree
  expect(nodes[1]!.entry).toBeUndefined(); // people: only a namespace
  const html = renderToStaticMarkup(<MemoryTree nodes={nodes} selected="projects.household" collapsed={new Set()} toggle={() => {}} select={() => {}} />);
  expect(html.match(/class="memory-key"/g)).toHaveLength(5); // projects, household, deploy, people, anya: each once
  expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
  expect(html).toContain('<div class="memory-row group"'); // people
  const folded = renderToStaticMarkup(<MemoryTree nodes={nodes} collapsed={new Set(["projects"])} toggle={() => {}} select={() => {}} />);
  expect(folded).not.toContain(">deploy<");
});
test("memory preview preserves arbitrary frontmatter and cannot load remote images or raw HTML",()=>{
  const html=renderToStaticMarkup(<SkillPreview parseFrontmatter={false} content={'---\nimportant: keep me\n---\n![secret](https://example.test/track)\n<script>alert(1)</script>'}/>);
  expect(html).toContain("important: keep me");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script");
});
