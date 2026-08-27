import path from "path"
import { fileURLToPath } from "node:url"
import z from "zod"
import { Global } from "../global"
import { ScopeContext } from "../scope/context"
import { Config } from "./config"
import { ConfigDomain } from "./domain"
import { ConfigImport } from "./import"
import * as Schema from "./schema"

export namespace ConfigExport {
  export const Query = z.object({
    scope: ConfigImport.Scope.optional(),
    only: z.array(ConfigDomain.Id).optional(),
    includeSecrets: z.boolean().optional(),
  })
  export type Query = z.infer<typeof Query>

  export const Result = z
    .object({
      scope: ConfigImport.Scope,
      scopeID: z.string(),
      secretsIncluded: z.boolean(),
      domains: z.array(ConfigDomain.Id),
      warnings: z.array(z.string()),
      config: Schema.Info,
    })
    .meta({ ref: "ConfigExportResult" })
  export type Result = z.infer<typeof Result>

  interface Target {
    scope: z.infer<typeof ConfigImport.Scope>
    scopeID: string
    root: string
  }

  export async function build(input: Query = {}): Promise<Result> {
    const parsed = Query.parse(input)
    const includeSecrets = parsed.includeSecrets ?? false
    const target = resolveTarget(parsed.scope ?? "global")
    const selected = new Set(parsed.only ?? ConfigDomain.definitions.map((domain) => domain.id))

    const aggregate: Record<string, unknown> = {}
    const exported: ConfigDomain.Id[] = []
    const warnings: string[] = []
    for (const definition of ConfigDomain.definitions) {
      if (!selected.has(definition.id)) continue
      const fragment = await Config.domainReadForExport(definition.id, target.root)
      if (fragment.error) {
        warnings.push(
          `Skipped ${definition.id}: ${ConfigDomain.filepath(definition.id, target.root)} could not be read (${fragment.error})`,
        )
      }
      if (Object.keys(fragment.config).length === 0) continue
      Object.assign(aggregate, fragment.config)
      exported.push(definition.id)
    }
    if (Array.isArray(aggregate.plugin)) {
      relativizePluginSpecs(aggregate.plugin as string[], ConfigDomain.directory(target.root))
    }

    // No $schema is added: the only schema URL the runtime knows is the
    // install-local file:// path, which is a broken link on any other
    // machine. The import side ignores $schema anyway.
    const config = Schema.Info.parse(
      includeSecrets ? (aggregate as Schema.Info) : Config.redactForClient(aggregate as Schema.Info),
    )
    return {
      scope: target.scope,
      scopeID: target.scopeID,
      secretsIncluded: includeSecrets,
      domains: exported,
      warnings,
      config,
    }
  }

  export function render(result: Result) {
    return Config.serializeConfig(result.config)
  }

  // Plugin specs in domain files are resolved to absolute file:// URLs when
  // the file is loaded (import.meta.resolve in Config.loadFile). Exports
  // must stay machine-independent, so those URLs go back to paths relative
  // to the config directory they were resolved from. Registry specs and
  // git/URL sources pass through unchanged.
  function relativizePluginSpecs(specs: string[], baseDir: string) {
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]
      if (!spec || !spec.startsWith("file://")) continue
      try {
        const relative = path.relative(baseDir, fileURLToPath(spec))
        if (relative === "") continue
        specs[i] = relative.startsWith(".") ? relative : `./${relative}`
      } catch {
        // Unconvertible file URL — keep the spec as loaded.
      }
    }
  }

  function resolveTarget(scope: z.infer<typeof ConfigImport.Scope>): Target {
    if (scope === "global") return { scope, scopeID: "home", root: Global.Path.config }
    const active = ScopeContext.tryScope()
    if (!active || active.type !== "project") {
      throw new ConfigImport.ProjectScopeRequiredError({
        message: "PROJECT_SCOPE_REQUIRED: Project config export requires an explicitly selected project scope.",
      })
    }
    return { scope, scopeID: active.id, root: path.join(active.directory, ".synergy") }
  }
}
