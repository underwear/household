/** Files read as text at build time (`import x from "./a.py" with { type: "text" }`), so a compiled house has them. */
declare module "*.py" {
  const text: string;
  export default text;
}
