import { pathToFileURL } from "url"

const marker = "__SYNERGY_PLUGIN_DEFINITION__"
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
process.stdout.write(
  marker +
    JSON.stringify({
      ...definition,
      __hasActivate: typeof definition.activate === "function",
      __hasDeactivate: typeof definition.deactivate === "function",
    }),
)
