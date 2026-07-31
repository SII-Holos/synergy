import { schemaToJsonSchema, type PluginContribution, type PluginDefinition } from "@ericsanchezok/synergy-plugin"
import { pathToFileURL } from "url"

const marker = "__SYNERGY_PLUGIN_DEFINITION__"
// Live Zod schemas must become JSON Schema before this descriptor crosses the JSON process boundary.
function serializeContribution(contribution: PluginContribution): PluginContribution {
  switch (contribution.kind) {
    case "operation":
      return {
        ...contribution,
        input: schemaToJsonSchema(contribution.input),
        output: schemaToJsonSchema(contribution.output),
      }
    case "event":
      return { ...contribution, payload: schemaToJsonSchema(contribution.payload) }
    case "tool":
      return { ...contribution, input: schemaToJsonSchema(contribution.input) }
    default:
      return contribution
  }
}

const entry = process.argv.at(-1)
if (!entry || entry === import.meta.path) throw new Error("Plugin definition entry argument is missing")

const module = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
const definition = [module.default, ...Object.values(module)].find((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === "string" &&
    typeof record.version === "string" &&
    Array.isArray(record.contributions) &&
    Array.isArray(record.handlerIds)
  )
}) as Record<string, unknown> | undefined
if (!definition) throw new Error(`No definePlugin() definition exported by ${entry}`)
const snapshot: PluginDefinition & Record<string, unknown> = {
  ...(definition as unknown as PluginDefinition),
  contributions: (definition.contributions as PluginContribution[]).map(serializeContribution),
}

process.stdout.write(
  marker +
    JSON.stringify({
      ...snapshot,
      __hasActivate: typeof snapshot.activate === "function",
      __hasDeactivate: typeof snapshot.deactivate === "function",
    }),
)
