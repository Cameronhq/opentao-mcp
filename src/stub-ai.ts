// Stub for the `ai` package. The `agents` client bundle has a dynamic
// `import("ai")` for AI-SDK tool conversion that we never hit on the MCP-server
// path. Aliased here (see wrangler.jsonc) so the Worker bundles without pulling
// in the full AI SDK.
export function jsonSchema(schema: unknown): unknown {
  return schema;
}
export default {};
