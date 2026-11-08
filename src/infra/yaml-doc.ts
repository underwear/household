import { isMap, Pair, Scalar, type Document } from "yaml";

/** doc.setIn cannot descend into a valueless key (`pets:` is a null scalar), so such parents become empty maps. */
export function setIn(doc: Document, path: string[], value: unknown): void {
  for (let depth = 1; depth < path.length; depth++) {
    const parent = path.slice(0, depth);
    if (doc.getIn(parent) === null) doc.setIn(parent, doc.createNode({}));
  }
  doc.setIn(path, value);
}

/** The config's `version`: the last config migration it has had; 0 when it has none (written before versions). */
export function configVersionOf(doc: Document): number {
  const version = doc.get("version");
  return typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : 0;
}

/** Sets the config's `version`, as its first key: the first thing a person opening the file sees. */
export function setConfigVersion(doc: Document, version: number): void {
  if (!isMap(doc.contents)) {
    doc.contents = doc.createNode({ version }) as typeof doc.contents;
    return;
  }
  const pair = doc.contents.items.find((item) => item.key instanceof Scalar ? item.key.value === "version" : item.key === "version");
  if (pair) pair.value = new Scalar(version);
  else doc.contents.items.unshift(new Pair(new Scalar("version"), new Scalar(version)));
}
