import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { HouseholdError } from "../core/errors";
import type { WebAssets } from "./web-server";

/**
 * Bundles the web UI from its HTML entry with Bun's bundler, in memory (its packages come from `web/node_modules`): the page (`/index.html`), its hashed
 * script and stylesheet (fonts inlined in it as data URLs). Takes a fraction of a second, so the daemon does it
 * at every start: no build step, no build output in the checkout.
 */
export async function buildWebBundle(entry: string): Promise<WebAssets> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: true,
    publicPath: "/",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    throw: false,
  });
  if (!result.success) {
    throw new HouseholdError(`the web UI did not build (its packages installed? \`bun install --cwd web\`):\n${result.logs.map(String).join("\n")}`);
  }
  const assets: WebAssets = new Map();
  for (const output of result.outputs) {
    assets.set(output.path.replace(/^\.\//, "/"), { body: new Uint8Array(await output.arrayBuffer()), type: output.type });
  }
  return assets;
}

const TYPES: Record<string, string> = {
  html: "text/html;charset=utf-8", js: "text/javascript;charset=utf-8", css: "text/css;charset=utf-8",
  svg: "image/svg+xml", json: "application/json;charset=utf-8", png: "image/png", woff2: "font/woff2",
};

/** Writes a bundle to `dir`, file by file, as a release ships it (`share/web`). */
export async function writeWebBundle(assets: WebAssets, dir: string): Promise<void> {
  for (const [path, { body }] of assets) await Bun.write(join(dir, path), body);
}

/** A bundle a release built ahead (`writeWebBundle`): a compiled house has no bundler inputs to build one from. */
export async function readWebBundle(dir: string): Promise<WebAssets> {
  const assets: WebAssets = new Map();
  for (const name of await readdir(dir, { recursive: true })) {
    const file = join(dir, name);
    if (!(await stat(file)).isFile()) continue;
    const type = TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream";
    assets.set(`/${name.split(sep).join("/")}`, { body: new Uint8Array(await Bun.file(file).arrayBuffer()), type });
  }
  if (!assets.has("/index.html")) throw new HouseholdError(`the web UI is missing from ${dir}: reinstall Household`);
  return assets;
}
