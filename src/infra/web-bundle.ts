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
