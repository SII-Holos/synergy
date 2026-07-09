import * as SolidRuntime from "solid-js"
import * as SolidStoreRuntime from "solid-js/store"
import * as SolidWebRuntime from "solid-js/web"
import * as SolidHRuntime from "solid-js/h"
import * as SolidJsxRuntime from "solid-js/h/jsx-runtime"

const PLUGIN_SOLID_RUNTIME_KEY = "__SYNERGY_PLUGIN_SOLID_RUNTIME__"

type SharedSolidRuntime = {
  solid: typeof SolidRuntime
  web: typeof SolidWebRuntime
  store: typeof SolidStoreRuntime
  h: typeof SolidHRuntime
  jsx: typeof SolidJsxRuntime
}

type SharedSolidRuntimeName = keyof SharedSolidRuntime

const SHARED_SOLID_IMPORTS: Record<string, SharedSolidRuntimeName> = {
  "solid-js": "solid",
  "solid-js/web": "web",
  "solid-js/store": "store",
  "solid-js/h": "h",
  "solid-js/h/jsx-runtime": "jsx",
  "solid-js/h/jsx-dev-runtime": "jsx",
}

const rewrittenPluginModuleUrls = new Map<string, string>()

function sharedSolidRuntime(): SharedSolidRuntime {
  const global = globalThis as typeof globalThis & { [PLUGIN_SOLID_RUNTIME_KEY]?: SharedSolidRuntime }
  global[PLUGIN_SOLID_RUNTIME_KEY] ??= {
    solid: SolidRuntime,
    web: SolidWebRuntime,
    store: SolidStoreRuntime,
    h: SolidHRuntime,
    jsx: SolidJsxRuntime,
  }
  return global[PLUGIN_SOLID_RUNTIME_KEY]
}

function runtimeAccessor(name: SharedSolidRuntimeName) {
  return `globalThis.${PLUGIN_SOLID_RUNTIME_KEY}.${name}`
}

function namedBindings(specifier: string) {
  return specifier
    .slice(1, -1)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("type "))
    .map((part) => {
      const match = /^(.*?)\s+as\s+(.*?)$/.exec(part)
      if (!match) return part
      return `${match[1].trim()}: ${match[2].trim()}`
    })
    .join(", ")
}

function splitImportClause(clause: string) {
  const trimmed = clause.trim()
  if (!trimmed) return []
  if (trimmed.startsWith("{")) return [trimmed]

  const namedStart = trimmed.indexOf("{")
  if (namedStart === -1) return [trimmed]
  return [trimmed.slice(0, namedStart).replace(/,$/, "").trim(), trimmed.slice(namedStart).trim()].filter(Boolean)
}

function rewriteImportClause(clause: string | undefined, runtimeName: SharedSolidRuntimeName) {
  const source = runtimeAccessor(runtimeName)
  if (!clause) return `void ${source};`

  const statements: string[] = []
  for (const item of splitImportClause(clause)) {
    if (item.startsWith("* as ")) {
      statements.push(`const ${item.slice(5).trim()} = ${source};`)
      continue
    }
    if (item.startsWith("{")) {
      const bindings = namedBindings(item)
      statements.push(bindings ? `const { ${bindings} } = ${source};` : `void ${source};`)
      continue
    }
    statements.push(`const ${item} = ${source}.default;`)
  }

  return statements.join("\n") || `void ${source};`
}

function rewriteSharedSolidImports(source: string) {
  return source.replace(
    /(^|\n)([ \t]*)import\s+(type\s+)?(?:([^"';]+?)\s+from\s+)?["'](solid-js(?:\/web|\/store|\/h|\/h\/jsx-runtime|\/h\/jsx-dev-runtime)?)["']\s*;?/g,
    (
      statement,
      lineStart: string,
      indent: string,
      typeOnly: string | undefined,
      clause: string | undefined,
      specifier: string,
    ) => {
      const runtimeName = SHARED_SOLID_IMPORTS[specifier]
      if (!runtimeName) return statement
      if (typeOnly) return lineStart
      const rewritten = rewriteImportClause(clause, runtimeName)
      return `${lineStart}${indent}${rewritten.replace(/\n/g, `\n${indent}`)}`
    },
  )
}

function hasUnsupportedSolidRuntimeImport(source: string) {
  return /(?:from\s+["']solid-js\/(?!web["']|store["']|h["']|h\/jsx-runtime["']|h\/jsx-dev-runtime["'])|import\s+["']solid-js\/(?!web["']|store["']|h["']|h\/jsx-runtime["']|h\/jsx-dev-runtime["'])|import\s*\(\s*["']solid-js(?:\/|["']))/.test(
    source,
  )
}

function hasBundledSolidRuntime(source: string) {
  return source.includes("node_modules/solid-js/dist/") || source.includes("Stale read from <")
}

async function resolvedPluginModuleUrl(pluginId: string, assetsBaseUrl: string) {
  console.log(`[plugin loader ${pluginId}] resolving module URL: ${assetsBaseUrl}`)
  const cached = rewrittenPluginModuleUrls.get(assetsBaseUrl)
  if (cached) {
    console.log(`[plugin loader ${pluginId}] using cached module URL`)
    return cached
  }

  sharedSolidRuntime()
  console.log(`[plugin loader ${pluginId}] shared solid runtime initialized`)
  const response = await fetch(assetsBaseUrl)
  console.log(`[plugin loader ${pluginId}] fetch response: ${response.status} ${response.statusText}`)
  if (!response.ok) throw new Error(`Failed to fetch plugin UI bundle: HTTP ${response.status}`)

  const source = await response.text()
  console.log(`[plugin loader ${pluginId}] bundle length: ${source.length}`)
  console.log(`[plugin loader ${pluginId}] bundle head:\n${source.slice(0, 400)}`)
  if (hasBundledSolidRuntime(source)) {
    throw new Error(`Plugin ${pluginId} bundles Solid runtime. Rebuild it with synergy-plugin build.`)
  }
  if (hasUnsupportedSolidRuntimeImport(source)) {
    throw new Error(
      `Plugin ${pluginId} imports an unsupported Solid runtime subpath. Use solid-js, solid-js/web, solid-js/store, solid-js/h, solid-js/h/jsx-runtime, or solid-js/h/jsx-dev-runtime.`,
    )
  }

  const rewritten = rewriteSharedSolidImports(source)
  console.log(`[plugin loader ${pluginId}] rewritten head:\n${rewritten.slice(0, 400)}`)
  const blob = new Blob([`${rewritten}\n//# sourceURL=${assetsBaseUrl}`], { type: "text/javascript" })
  const url = URL.createObjectURL(blob)
  rewrittenPluginModuleUrls.set(assetsBaseUrl, url)
  console.log(`[plugin loader ${pluginId}] created blob URL: ${url}`)
  return url
}

/** Current UI API version this host supports. */
export const CURRENT_UI_API_VERSION = "3.0"

/** Check if a plugin's required UI API version is compatible with the host. */
export function isCompatibleUIVersion(pluginVersion: string, hostVersion: string): boolean {
  const [pluginMajor] = pluginVersion.split(".").map(Number)
  const [hostMajor] = hostVersion.split(".").map(Number)
  return pluginMajor === hostMajor
}

/**
 * Load a single named export from a Tier 2 plugin's UI bundle.
 *
 * Verifies the plugin's required UI API version against the host's version
 * before importing. Throws if the versions are incompatible.
 *
 * @param pluginId        - Unique plugin identifier
 * @param assetsBaseUrl   - Fully resolved URL for the plugin UI asset.
 * @param exportName      - Named export to pull from the bundle (use "default" for default export)
 * @param uiApiVersion    - Minimum UI API version the plugin requires (e.g. "3.0")
 */
export async function loadPluginExport<T = unknown>(
  pluginId: string,
  assetsBaseUrl: string,
  exportName: string,
  uiApiVersion: string,
): Promise<{ default: T }> {
  if (uiApiVersion && !isCompatibleUIVersion(uiApiVersion, CURRENT_UI_API_VERSION)) {
    throw new Error(`Plugin ${pluginId} requires UI API ${uiApiVersion} but host is ${CURRENT_UI_API_VERSION}`)
  }
  console.log(`[plugin loader ${pluginId}] loadPluginExport called: export="${exportName}" url=${assetsBaseUrl}`)
  try {
    console.log(`[plugin loader ${pluginId}] loading export "${exportName}" from ${assetsBaseUrl}`)
    const moduleUrl = await resolvedPluginModuleUrl(pluginId, assetsBaseUrl)
    console.log(`[plugin loader ${pluginId}] importing module URL: ${moduleUrl}`)
    const mod = (await import(/* @vite-ignore */ moduleUrl)) as Record<string, unknown>
    console.log(`[plugin loader ${pluginId}] module imported. keys:`, Object.keys(mod))
    const exported = mod[exportName]
    console.log(`[plugin loader ${pluginId}] export "${exportName}" resolved to:`, typeof exported, exported)
    if (exported === undefined) {
      throw new Error(`Export "${exportName}" not found in plugin ${pluginId} bundle at ${assetsBaseUrl}`)
    }
    return { default: exported as T }
  } catch (err) {
    console.error(`[plugin loader ${pluginId}] failed to load "${exportName}" from ${assetsBaseUrl}:`, err)
    if (err instanceof Error && err.message.startsWith("Export ")) throw err
    throw new Error(
      `Failed to load plugin ${pluginId} from ${assetsBaseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
