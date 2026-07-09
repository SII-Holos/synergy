// undici is built into Bun but tsgo doesn't resolve its types.
// This declaration silences TS2307 without affecting runtime behavior.
declare module "undici" {
  export const ProxyAgent: any
  export const Agent: any
}
