// bun `with { type: "file" }` imports a raw binary, not a JS module.
declare module "*.bin" {
  const path: string;
  export default path;
}
