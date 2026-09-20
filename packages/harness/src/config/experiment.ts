import { RuntimeContext } from "../lifecycle/context"
import { ConfigExtensions } from "./extensions"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import z from "zod"
import { CoreInfo, Info as ConfigSchema } from "./schema"

export namespace Experiment {
  const Execution = CoreInfo.shape.execution.unwrap()
  const Cortex = CoreInfo.shape.cortex.unwrap()
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
  export const Overrides = CoreInfo.pick({
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
  const runtimeState = RuntimeContext.state(() => ({
    runtimeConfig: undefined as z.infer<typeof Runtime> | undefined,
    runtimeOverrides: undefined as z.infer<typeof Runtime> | undefined,
    applied: new WeakMap<Config, WeakMap<object, WeakMap<object, Config>>>(),
  }))

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
    const runtime = runtimeState().runtimeConfig ?? runtimeFrom(config)
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
  // apply() composes and parses the configuration, and the turn path resolves it
  // on every round. The memo is keyed by the identity of all three inputs — the
  // live config, the runtime overrides, and the active snapshot — so an unchanged
  // triple reuses one parsed object while a reload, a reconfigure, or a different
  // run still parses again. Weak keys keep the memo proportional to inputs still
  // in use.
  const NO_RUNTIME_OVERRIDES = {}
  const NO_SNAPSHOT = {}

  export function apply(live: Config): Config {
    const instanceState = runtimeState()

    const overrides = instanceState.runtimeOverrides
    const snapshot = current()
    if (!overrides && !snapshot) return live

    const overridesKey: object = overrides ?? NO_RUNTIME_OVERRIDES
    let byOverrides = instanceState.applied.get(live)
    if (!byOverrides) {
      byOverrides = new WeakMap()
      instanceState.applied.set(live, byOverrides)
    }
    let bySnapshot = byOverrides.get(overridesKey)
    if (!bySnapshot) {
      bySnapshot = new WeakMap()
      byOverrides.set(overridesKey, bySnapshot)
    }
    const snapshotKey: object = snapshot ?? NO_SNAPSHOT
    const cached = bySnapshot.get(snapshotKey)
    if (cached) return cached

    let value = overrides ? applyRuntime(live, overrides) : live
    if (snapshot) {
      const result = { ...value }
      for (const key of taskKeys) delete (result as Record<string, unknown>)[key]
      value = ConfigSchema.parse({
        ...result,
        ...snapshot.effective,
        execution: { ...value.execution, ...snapshot.effective.execution },
        cortex: { ...value.cortex, ...snapshot.effective.cortex },
      })
    }
    bySnapshot.set(snapshotKey, value)
    return value
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
    const instanceState = runtimeState()

    instanceState.runtimeConfig = config ? runtimeFrom(config) : undefined
    instanceState.runtimeOverrides = overrides
  }
  export function updateRuntime(patch: z.infer<typeof Runtime>) {
    const instanceState = runtimeState()

    if (instanceState.runtimeConfig)
      instanceState.runtimeConfig = Runtime.parse(merge(instanceState.runtimeConfig, patch))
  }
  export function assertRuntime(expected: z.infer<typeof Runtime>) {
    const instanceState = runtimeState()

    if (!Object.keys(expected).length) return
    if (
      !instanceState.runtimeConfig ||
      fingerprint(merge(instanceState.runtimeConfig, expected)) !== fingerprint(instanceState.runtimeConfig)
    )
      throw new Error("Experiment runtime settings differ from the running server; use a separately configured runtime")
  }
}
