/**
 * Shared helper used by both the plugin build toolchain and the Synergy server
 * to rewrite Solid runtime imports in plugin UI bundles so they resolve against
 * the host's shared Solid runtime instead of being bundled or resolved as npm
 * package paths.
 */

export const PLUGIN_SOLID_RUNTIME_KEY = "__SYNERGY_PLUGIN_SOLID_RUNTIME__"

export const SHARED_SOLID_IMPORTS: Record<string, string> = {
  "solid-js": "solid",
  "solid-js/web": "web",
  "solid-js/store": "store",
  "solid-js/h": "h",
  "solid-js/h/jsx-runtime": "jsx",
  "solid-js/h/jsx-dev-runtime": "jsx",
}

function runtimeAccessor(name: string) {
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
      return `${match[1]!.trim()}: ${match[2]!.trim()}`
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

function rewriteImportClause(clause: string | undefined, runtimeName: string) {
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

/**
 * Rewrite imports for the Solid runtime subpaths that the host shares with
 * plugins so they read from the global shared runtime object.
 */
export function rewritePluginSolidImports(source: string): string {
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

/**
 * Detect whether a plugin UI bundle still contains un-rewritten Solid runtime
 * imports that the host cannot resolve.
 */
export function hasUnsupportedSolidRuntimeImport(source: string) {
  return /(?:from\s+["']solid-js\/(?!web["']|store["']|h["']|h\/jsx-runtime["']|h\/jsx-dev-runtime["'])|import\s+["']solid-js\/(?!web["']|store["']|h["']|h\/jsx-runtime["']|h\/jsx-dev-runtime["'])|import\s*\(\s*["']solid-js(?:\/|["']))/.test(
    source,
  )
}

/**
 * Detect whether a plugin UI bundle appears to have bundled Solid runtime code
 * instead of externalizing it.
 */
export function hasBundledSolidRuntime(source: string) {
  return source.includes("node_modules/solid-js/dist/") || source.includes("Stale read from <")
}
