import { ConfigExtensions } from "./extensions"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import z from "zod"
import { Info as ConfigSchema } from "./schema"

export namespace Experiment {
  const Execution = ConfigSchema.shape.execution.unwrap()
  const Cortex = ConfigSchema.shape.cortex.unwrap()
  const taskKeys = [
    "compaction",
    "prompt",
    "toolExposure",
    "lspWriteDiagnostics",
    "lspDiagnostics",
    "model",
    "nano_model",
    "mini_model",
    "mid_model",
    "thinking_model",
    "long_context_model",
    "creative_model",
    "vision_model",
    "role_variant",
  ] as const
  export const Overrides = ConfigSchema.pick({
    compaction: true,
    prompt: true,

    model: true,
    nano_model: true,
    mini_model: true,
    mid_model: true,
    thinking_model: true,
    long_context_model: true,
    creative_model: true,
    vision_model: true,
    role_variant: true,
  })
    .extend({
      toolExposure: ConfigExtensions.field("toolExposure"),
      lspWriteDiagnostics: ConfigExtensions.field("lspWriteDiagnostics"),
      lspDiagnostics: ConfigExtensions.field("lspDiagnostics"),
      execution: Execution.pick({ continueOnDeny: true, messageCache: true }).strict().optional(),
      cortex: Cortex.pick({ primaryOnlyTools: true }).strict().optional(),
    })
    .strict()
    .meta({ ref: "ExperimentOverrides" })
  export const Runtime = z
    .object({ lsp: ConfigExtensions.field("lsp"), formatter: ConfigExtensions.field("formatter") })
    .extend({
      execution: Execution.omit({ continueOnDeny: true, messageCache: true }).strict().optional(),
      cortex: Cortex.pick({ maxConcurrentTasks: true }).strict().optional(),
    })
    .strict()
    .meta({ ref: "ExperimentRuntime" })
  export const File = z
    .object({
      version: z.literal(1),
      label: z.string().trim().min(1).max(200),
      overrides: Overrides.default({}),
      runtime: Runtime.default({}),
    })
    .strict()
    .meta({ ref: "ExperimentFile" })
  export type File = z.infer<typeof File>
  export const Source = z.enum([
    "default",
    "remote_base",
    "global_config",
    "project_config",
    "explicit_file",
    "inline_config",
    "legacy_environment",
    "resolved_configuration",
    "experiment",
    "explicit_command",
  ])
  export type Source = z.infer<typeof Source>
  export const Snapshot = z
    .object({
      version: z.literal(1),
      label: z.string(),
      capturedAt: z.number(),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      effective: Overrides,
      overrides: Overrides,
      runtime: Runtime,
      sources: z.record(z.string(), Source),
    })
    .strict()
    .meta({ ref: "ExperimentSnapshot" })
  export type Snapshot = z.infer<typeof Snapshot>
  const storage = new AsyncLocalStorage<Snapshot>()
  let runtimeConfig: z.infer<typeof Runtime> | undefined
  let runtimeOverrides: z.infer<typeof Runtime> | undefined
  type Config = z.infer<typeof ConfigSchema>

  function object(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }
  function merge(base: unknown, patch: unknown): unknown {
    if (!object(base) || !object(patch)) return structuredClone(patch)
    const result = { ...base }
    for (const [key, value] of Object.entries(patch)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid experiment key")
      result[key] = merge(base[key], value)
    }
    return result
  }
  export function fingerprint(value: unknown): string {
    function canonical(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(canonical)
      if (!object(value)) return value
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .filter((key) => value[key] !== undefined)
          .map((key) => [key, canonical(value[key])]),
      )
    }
    return createHash("sha256")
      .update(JSON.stringify(canonical(value)))
      .digest("hex")
  }
  export function capture(
    config: Config,
    file?: File,
    explicit: z.infer<typeof Overrides> = {},
    origins?: Record<string, Source>,
  ): Snapshot {
    const base = Overrides.parse({
      ...Object.fromEntries(
        taskKeys.map((key) => [key, key in ConfigSchema.shape ? (config as Record<string, unknown>)[key] : undefined]),
      ),
      execution: {
        continueOnDeny: config.execution?.continueOnDeny ?? false,
        messageCache: {
          enabled: config.execution?.messageCache?.enabled ?? true,
          verify: config.execution?.messageCache?.verify ?? false,
        },
      },
      cortex: { primaryOnlyTools: config.cortex?.primaryOnlyTools ?? [] },
    })
    const overrides = file?.overrides ?? {}
    const effective = Overrides.parse(merge(merge(base, overrides), Overrides.parse(explicit)))
    const sources: Snapshot["sources"] = {}
    function source(value: unknown, name: Snapshot["sources"][string], prefix = "") {
      if (!object(value)) {
        sources[prefix] = name
        return
      }
      for (const [key, entry] of Object.entries(value))
        if (entry !== undefined) source(entry, name, prefix ? `${prefix}.${key}` : key)
    }
    source(base, "resolved_configuration")
    if (origins) for (const key of Object.keys(sources)) sources[key] = origins[key] ?? "default"
    source(overrides, "experiment")
    source(explicit, "explicit_command")
    const runtime = runtimeConfig ?? runtimeFrom(config)
    return Snapshot.parse({
      version: 1,
      label: file?.label ?? "default",
      capturedAt: Date.now(),
      fingerprint: fingerprint({ effective, runtime }),
      effective,
      overrides,
      runtime,
      sources,
    })
  }
  export async function resolve(): Promise<Snapshot> {
    const inherited = current()
    if (inherited) return inherited
    const [{ Config }, { ScopeContext }, { Scope }] = await Promise.all([
      import("./config"),
      import("../scope/context"),
      import("../scope"),
    ])
    const config = await ScopeContext.provide({
      scope: ScopeContext.tryScope() ?? Scope.home(),
      fn: () => Config.resolveExecutionDetails(),
    })
    return capture(config.config, undefined, {}, config.sources)
  }
  function freeze(value: unknown) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  export function current() {
    return storage.getStore()
  }
  export function provide<T>(snapshot: Snapshot, action: () => T): T {
    const copy = Snapshot.parse(snapshot)
    freeze(copy)
    return storage.run(copy, action)
  }
  export function apply(live: Config): Config {
    if (runtimeOverrides) live = applyRuntime(live, runtimeOverrides)
    const snapshot = current()
    if (!snapshot) return live
    const result = { ...live }
    for (const key of taskKeys) delete (result as Record<string, unknown>)[key]
    return ConfigSchema.parse({
      ...result,
      ...snapshot.effective,
      execution: { ...live.execution, ...snapshot.effective.execution },
      cortex: { ...live.cortex, ...snapshot.effective.cortex },
    })
  }
  export function applyRuntime(config: Config, runtime: z.infer<typeof Runtime>): Config {
    return ConfigSchema.parse(merge(config, Runtime.parse(runtime)))
  }
  function runtimeFrom(config: Config) {
    const { continueOnDeny, messageCache, ...execution } = config.execution ?? {}
    return Runtime.parse({
      lsp: ConfigExtensions.readField(config, "lsp"),
      formatter: ConfigExtensions.readField(config, "formatter"),
      execution,
      cortex: { maxConcurrentTasks: config.cortex?.maxConcurrentTasks },
    })
  }
  export function configureRuntime(config?: Config, overrides?: z.infer<typeof Runtime>) {
    runtimeConfig = config ? runtimeFrom(config) : undefined
    runtimeOverrides = overrides
  }
  export function updateRuntime(patch: z.infer<typeof Runtime>) {
    if (runtimeConfig) runtimeConfig = Runtime.parse(merge(runtimeConfig, patch))
  }
  export function assertRuntime(expected: z.infer<typeof Runtime>) {
    if (!Object.keys(expected).length) return
    if (!runtimeConfig || fingerprint(merge(runtimeConfig, expected)) !== fingerprint(runtimeConfig))
      throw new Error("Experiment runtime settings differ from the running server; use a separately configured runtime")
  }
}
