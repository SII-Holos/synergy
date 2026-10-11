import { RuntimeContext } from "../lifecycle/context"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { Config } from "../config/config"
import path from "path"
import fs from "fs"
import { type ToolDefinition, type ToolDisplay } from "@ericsanchezok/synergy-util/tool"
import z from "zod"
import Ajv2020 from "ajv/dist/2020"
import { ToolPluginSource } from "./plugin-source"
import type { SettingCondition as PluginSettingCondition } from "@ericsanchezok/synergy-util/setting-condition"
import { Log } from "../util/log"
import { Truncate } from "./truncation"
import { SearchToolsTool } from "./search-tools"
import { ExpandToolsTool } from "./expand-tools"
import { ToolExposure } from "./exposure"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  export const state = ScopedState.create(async () => {
    const custom = [] as Tool.Info[]
    const glob = new Bun.Glob("tool/*.{js,ts}")

    for (const dir of await Config.directories()) {
      if (!isDirectory(dir)) continue
      for await (const match of glob.scan({
        cwd: dir,
        absolute: true,
        followSymlinks: true,
        dot: true,
      })) {
        const namespace = path.basename(match, path.extname(match))
        const mod = await import(match)
        for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
          custom.push(fromPlugin(`local__${namespace}__${id}`, def))
        }
      }
    }

    const pluginEntries = (await ToolPluginSource.get()?.toolEntries()) ?? []
    for (const entry of pluginEntries) {
      custom.push(fromRuntimePlugin(entry))
    }

    return { custom, findCache: new Map<string, { id: string } & Awaited<ReturnType<Tool.Info["init"]>>>() }
  })

  function isDirectory(dir: string) {
    try {
      return fs.statSync(dir).isDirectory()
    } catch {
      return false
    }
  }

  export async function reload() {
    log.info("reloading tool registry state")
    await state.resetAll()
    log.info("tool registry state reloaded")
  }

  function fromPlugin(id: string, def: ToolDefinition, exposure?: ToolExposure.Info, display?: ToolDisplay): Tool.Info {
    return {
      id,
      requiresWorkspace: def.requiresWorkspace ?? true,
      exposure,
      display: display ?? (def as ToolDefinition & { display?: ToolDisplay }).display,
      source: { type: "local" },
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const pluginCtx = {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            agent: ctx.agent,
            abort: ctx.abort,
            directory: ScopeContext.current.workspace?.path,
            ask: (input: { permission: string; patterns: string[]; metadata?: Record<string, any> }) =>
              ctx.ask({ ...input, metadata: input.metadata ?? {} }),
          }
          const raw = await Tool.withWorkspace(def.requiresWorkspace ?? true, ctx, () =>
            def.execute(args as any, pluginCtx),
          )
          await ctx.captureResult?.(raw)
          return normalizePluginResult(raw, initCtx?.agent)
        },
      }),
    }
  }

  function assertWorkspace(required: boolean) {
    if (required && !ScopeContext.current.workspace)
      throw new Scope.WorkspaceRequiredError({
        message: "This plugin tool requires a local workspace.",
        scopeID: ScopeContext.current.scope.id,
      })
  }

  function manifestParameters(schema: Record<string, unknown>): z.ZodType {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
    const result = z.custom((value) => validate(value), {
      error: () => ({ message: new Ajv2020().errorsText(validate.errors) }),
    })
    return result
  }

  export function matchesSettingCondition(condition: PluginSettingCondition, values: Record<string, unknown>): boolean {
    return values[condition.setting] === condition.equals
  }

  async function conditionEnabled(pluginId: string, condition: PluginSettingCondition): Promise<boolean> {
    return (await ToolPluginSource.get()?.conditionEnabled(pluginId, condition)) ?? false
  }

  async function enabled(tool: Tool.Info, workspaceID?: string | null): Promise<boolean> {
    if (tool.requiresWorkspace && !workspaceID && !ScopeContext.current.workspace) return false
    if (!tool.enabledWhen) return true
    if (tool.source?.type !== "plugin") return false
    return conditionEnabled(tool.source.pluginId, tool.enabledWhen)
  }

  function fromRuntimePlugin(entry: ToolPluginSource.Entry): Tool.Info {
    return {
      id: entry.fullId,
      requiresWorkspace: entry.requiresWorkspace ?? true,
      exposure: entry.exposure,
      display: entry.display,
      source: {
        type: "plugin",
        pluginId: entry.pluginId,
        toolId: entry.toolId,
        pluginDir: entry.pluginDir,
        runtimeMode: "process",
      },
      inputSchema: entry.inputSchema,
      enabledWhen: entry.enabledWhen,
      init: async (initCtx) => ({
        parameters: manifestParameters(entry.inputSchema),
        description: entry.description,
        execute: async (args, ctx) => {
          assertWorkspace(entry.requiresWorkspace ?? true)
          if (entry.enabledWhen && !(await conditionEnabled(entry.pluginId, entry.enabledWhen))) {
            throw Object.assign(new Error(`Plugin tool ${entry.fullId} is disabled by plugin settings.`), {
              code: "CONTRIBUTION_DISABLED",
            })
          }
          const raw = await Tool.withWorkspace(entry.requiresWorkspace ?? true, ctx, () =>
            entry.execute(args, {
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              agent: ctx.agent,
              abort: ctx.abort,
              callID: ctx.callID,
              userMessageID: typeof ctx.extra?.userMessageID === "string" ? ctx.extra.userMessageID : undefined,
              scopeId: ScopeContext.current.scope.id,
              directory: ScopeContext.current.workspace?.path,
            }),
          )
          await ctx.captureResult?.(raw)
          return normalizePluginResult(raw, initCtx?.agent)
        },
      }),
    }
  }

  async function normalizePluginResult(raw: unknown, agent?: Agent.Info) {
    if (typeof raw === "object" && raw !== null && "output" in raw) {
      const structured = raw as {
        title?: string
        output: string
        metadata?: Record<string, any>
        attachments?: any
      }
      const out = await Truncate.output(structured.output, {}, agent)
      return {
        title: structured.title ?? "",
        output: out.truncated ? out.content : structured.output,
        metadata: {
          ...structured.metadata,
          truncated: out.truncated,
          outputPath: out.truncated ? out.outputPath : undefined,
        },
        attachments: structured.attachments,
      }
    }
    const text = raw as string
    const out = await Truncate.output(text, {}, agent)
    return {
      title: "",
      output: out.truncated ? out.content : text,
      metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
    }
  }

  const runtimeState = RuntimeContext.state(() => ({
    toolProviders: new Map<string, ToolProvider>(),
  }))
  export type ToolProvider = () => Tool.Info[] | Promise<Tool.Info[]>

  /** Product domains register tool providers under a stable source id;
   * `all()` drains them alongside the static builtin list. */
  export function registerToolProvider(sourceID: string, provider: ToolProvider): void {
    const instanceState = runtimeState()

    const existing = instanceState.toolProviders.get(sourceID)
    if (existing === provider) return
    RuntimeContext.assertCompositionOpen(`tool provider ${sourceID}`)
    if (existing) throw new Error(`Tool provider ${sourceID} is already registered`)
    instanceState.toolProviders.set(sourceID, provider)
  }

  export function toolProviderIDs(): string[] {
    const instanceState = runtimeState()

    return [...instanceState.toolProviders.keys()].sort()
  }

  export async function register(tool: Tool.Info) {
    const { custom, findCache } = await state()
    findCache.delete(tool.id)
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
      return
    }
    custom.push(tool)
  }

  /** Composing hosts can attach product metadata without reimplementing discovery. */
  export function discoveryTools(): readonly Tool.Info[] {
    return [SearchToolsTool, ExpandToolsTool]
  }

  async function all(): Promise<Tool.Info[]> {
    const instanceState = runtimeState()

    const custom = await state().then((x) => x.custom)
    await Config.current()

    const builtin = discoveryTools()

    const provided = (await Promise.all([...instanceState.toolProviders.values()].map((provider) => provider()))).flat()
    return [...builtin, ...provided, ...custom]
  }

  export async function ids() {
    const tools = await all()
    return (await Promise.all(tools.map(async (tool) => ((await enabled(tool)) ? tool.id : undefined)))).filter(
      (id): id is string => Boolean(id),
    )
  }

  export async function find(id: string) {
    const tools = await all()
    const tool = tools.find((t) => t.id === id)
    if (!tool) return undefined
    if (!(await enabled(tool))) return undefined
    const { findCache } = await state()
    const cached = findCache.get(id)
    if (cached) return cached
    const def = await tool.init()
    const result = { id: tool.id, ...def }
    findCache.set(id, result)
    return result
  }

  export type Initialized = Omit<Tool.Info, "init" | "catalogDescription"> & Awaited<ReturnType<Tool.Info["init"]>>
  export type Deferred = Pick<
    Initialized,
    "id" | "requiresWorkspace" | "requiresExecution" | "exposure" | "display" | "source"
  > & {
    description: string
    resolve(): Promise<Initialized>
  }
  export type CatalogEntry = Initialized | Deferred

  export async function catalog(
    providerID: string,
    agent?: Agent.Info,
    workspaceID?: string | null,
  ): Promise<CatalogEntry[]> {
    const allTools = await all()
    const tools = (
      await Promise.all(allTools.map(async (tool) => ((await enabled(tool, workspaceID)) ? tool : undefined)))
    ).filter((tool): tool is Tool.Info => Boolean(tool))
    const results = await Promise.allSettled(
      tools.map(async (t): Promise<CatalogEntry> => {
        const metadata = {
          id: t.id,
          requiresWorkspace: t.requiresWorkspace ?? false,
          requiresExecution: t.requiresExecution,
          exposure: ToolExposure.deferredExposure(t.id, ToolExposure.normalize(t.id, t.exposure), agent?.deferredTools),
          display: t.display,
          source: t.source,
        }
        const resolve = async (): Promise<Initialized> => ({
          ...metadata,
          inputSchema: t.inputSchema,
          ...(await t.init({ agent })),
        })
        return t.catalogDescription === undefined
          ? resolve()
          : { ...metadata, description: t.catalogDescription, resolve }
      }),
    )
    return successful(tools, results)
  }

  export async function tools(
    providerID: string,
    agent?: Agent.Info,
    workspaceID?: string | null,
  ): Promise<Initialized[]> {
    const entries = await catalog(providerID, agent, workspaceID)
    return successful(
      entries,
      await Promise.allSettled(entries.map((item) => ("resolve" in item ? item.resolve() : Promise.resolve(item)))),
    )
  }

  function successful<T>(tools: { id: string }[], results: PromiseSettledResult<T>[]): T[] {
    const values: T[] = []
    for (let i = 0; i < results.length; i++) {
      const item = results[i]
      if (item.status === "fulfilled") values.push(item.value)
      else log.warn("tool skipped due to init failure", { tool: tools[i]?.id, error: String(item.reason) })
    }
    return values
  }
}
