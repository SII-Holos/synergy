import { z } from "zod"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
export interface ChannelKinds {}
export type Channel = {
  type: string
  accounts: Record<string, Record<string, unknown> & { enabled?: boolean }>
  [key: string]: unknown
}
export namespace ChannelConfigRegistry {
  const state = RuntimeContext.state(() => new Map<string, z.ZodObject>())
  export function register(id: string, schema: z.ZodObject) {
    RuntimeContext.assertCompositionOpen("channel config")
    if (state().has(id)) throw new Error(`Duplicate Channel schema ${id}`)
    state().set(id, schema)
  }
  export function storedSchema() {
    return z.record(z.string(), z.unknown()).superRefine((channels, ctx) => {
      for (const [id, value] of Object.entries(channels)) {
        if (!value || typeof value !== "object" || !("type" in value)) continue
        const schema = state().get(String(value.type))
        if (!schema) continue
        const parsed = schema.safeParse(value)
        if (!parsed.success)
          for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: [id, ...issue.path] })
      }
    })
  }
  export function ids() {
    return [...state().keys()].sort()
  }
  export function schema(): z.ZodType<Channel> {
    const schemas = [...state().values()]
    return (schemas.length ? z.union(schemas) : z.never()) as z.ZodType<Channel>
  }
}
export const ConfigShape = {
  channel: z
    .lazy(() => z.record(z.string(), ConfigExtensions.dynamicSchema(ChannelConfigRegistry.schema)))
    .optional()
    .describe("Channel configurations for selected messaging providers"),
}
type ConfigShapeType = typeof ConfigShape
export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>
declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
export function registerConfig() {
  ConfigExtensions.register("channels", {
    shape: ConfigShape,
    storedShape: { channel: ConfigExtensions.dynamicSchema(ChannelConfigRegistry.storedSchema).optional() },
    project(raw) {
      if (!raw.channel || typeof raw.channel !== "object") return
      const ids = new Set(ChannelConfigRegistry.ids())
      for (const [id, value] of Object.entries(raw.channel))
        if (!value || typeof value !== "object" || !("type" in value) || !ids.has(String(value.type)))
          delete (raw.channel as Record<string, unknown>)[id]
    },
  })
  ConfigDomain.register({
    id: "channels",
    filename: "90-channels.jsonc",
    label: "Channels",
    ownedKeys: ["channel"],
    mergePolicy: "merge",
    reloadTargets: ["config"],
    uiSection: "channels",
    importable: true,
  })
}
export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
