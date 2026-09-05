import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { FileSearchTool } from "./file-search"
import { ReadTool } from "./read"
import { ViewFileTool } from "./view-file"
import { ViewImageTool } from "./view-image"
import { ReviseFileTool } from "./revise-file"
import { ResolveConflictsTool } from "./resolve-conflicts"
import { SaveFileTool } from "./save-file"
import { ScanFilesTool } from "./scan-files"
import { ParseCodeTool } from "./parse-code"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { DagWriteTool, DagReadTool, DagPatchTool } from "./dag"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { SessionListTool } from "./session-list"
import { SessionReadTool } from "./session-read"
import { SessionSearchTool } from "./session-search"
import { SessionSendTool } from "./session-send"

import { ScopeListTool } from "./scope-list"
import { AttachTool } from "./attach"
import { SpeakTool } from "./speak"
import { OpenAIImageGenTool } from "./openai-image-gen"
import { OpenAIImageEditTool } from "./openai-image-edit"

import { SkillTool } from "./skill"
import { LookAtTool } from "./lookat"
import { ScanDocumentTool } from "./scan-document"
import { AstGrepTool } from "./ast-grep"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { Config } from "../config/config"
import path from "path"
import fs from "fs"
import { type ToolDefinition, type ToolDisplay } from "@ericsanchezok/synergy-plugin/tool"
import z from "zod"
import Ajv2020 from "ajv/dist/2020"
import { ToolPluginSource } from "./plugin-source"
import type { PluginSettingCondition } from "@ericsanchezok/synergy-plugin"
import { Log } from "@/util/log"
import { ProcessTool } from "./process"
import { Truncate } from "./truncation"
import { RenderTool } from "./render"
import { RuntimeReloadTool } from "./runtime-reload"
import { CodexProvider } from "@/provider/codex"
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

    return { custom }
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
    findCache.clear()
    await state.resetAll()
    log.info("tool registry state reloaded")
  }

  function fromPlugin(id: string, def: ToolDefinition, exposure?: ToolExposure.Info, display?: ToolDisplay): Tool.Info {
    return {
      id,
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
            directory: ScopeContext.current.directory,
            ask: (input: { permission: string; patterns: string[]; metadata?: Record<string, any> }) =>
              ctx.ask({ ...input, metadata: input.metadata ?? {} }),
          }
          const raw = await def.execute(args as any, pluginCtx)
          return normalizePluginResult(raw, initCtx?.agent)
        },
      }),
    }
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

  async function enabled(tool: Tool.Info): Promise<boolean> {
    if (!tool.enabledWhen) return true
    if (tool.source?.type !== "plugin") return false
    return conditionEnabled(tool.source.pluginId, tool.enabledWhen)
  }

  function fromRuntimePlugin(entry: ToolPluginSource.Entry): Tool.Info {
    return {
      id: entry.fullId,
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
          if (entry.enabledWhen && !(await conditionEnabled(entry.pluginId, entry.enabledWhen))) {
            throw Object.assign(new Error(`Plugin tool ${entry.fullId} is disabled by plugin settings.`), {
              code: "CONTRIBUTION_DISABLED",
            })
          }
          const raw = await entry.execute(args, {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            agent: ctx.agent,
            abort: ctx.abort,
            callID: ctx.callID,
            userMessageID: typeof ctx.extra?.userMessageID === "string" ? ctx.extra.userMessageID : undefined,
            scopeId: ScopeContext.current.scope.id,
            directory: ScopeContext.current.directory,
          })
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

  const toolProviders = new Map<string, ToolProvider>()
  export type ToolProvider = () => Tool.Info[]

  /** Product domains register tool providers under a stable source id;
   * `all()` drains them alongside the static builtin list. */
  export function registerToolProvider(sourceID: string, provider: ToolProvider): void {
    toolProviders.set(sourceID, provider)
  }

  export function toolProviderIDs(): string[] {
    return [...toolProviders.keys()].sort()
  }

  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
      return
    }
    custom.push(tool)
  }

  async function all(): Promise<Tool.Info[]> {
    const custom = await state().then((x) => x.custom)
    await Config.current()

    const builtin: Tool.Info[] = [
      BashTool,
      ProcessTool,
      ReadTool,
      ViewImageTool,
      ViewFileTool,
      ScanFilesTool,
      FileSearchTool,
      ParseCodeTool,
      ReviseFileTool,
      ResolveConflictsTool,
      SaveFileTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      WebFetchTool,
      TodoWriteTool,
      TodoReadTool,
      DagWriteTool,
      DagReadTool,
      DagPatchTool,
      SearchToolsTool,
      ExpandToolsTool,
      SkillTool,
      LookAtTool,
      ScanDocumentTool,
      AstGrepTool,
      SessionListTool,
      SessionReadTool,
      SessionSearchTool,
      SessionSendTool,
      ScopeListTool,
      AttachTool,
      SpeakTool,
      RenderTool,
      RuntimeReloadTool,
    ]

    const codexAccess = await CodexProvider.resolveToken({
      allowMissing: true,
      refreshIfExpiring: false,
    }).catch(() => undefined)
    if (codexAccess) builtin.push(OpenAIImageGenTool, OpenAIImageEditTool)

    const provided = [...toolProviders.values()].flatMap((provider) => provider())
    return [...builtin, ...provided, ...custom]
  }

  export async function ids() {
    const tools = await all()
    return (await Promise.all(tools.map(async (tool) => ((await enabled(tool)) ? tool.id : undefined)))).filter(
      (id): id is string => Boolean(id),
    )
  }

  const findCache = new Map<string, { id: string; description: string; parameters: any; execute: Function }>()

  export async function find(id: string) {
    const tools = await all()
    const tool = tools.find((t) => t.id === id)
    if (!tool) return undefined
    if (!(await enabled(tool))) return undefined
    const cached = findCache.get(id)
    if (cached) return cached
    const def = await tool.init()
    const result = { id: tool.id, ...def }
    findCache.set(id, result)
    return result
  }

  export async function tools(providerID: string, agent?: Agent.Info) {
    const allTools = await all()
    const tools = (await Promise.all(allTools.map(async (tool) => ((await enabled(tool)) ? tool : undefined)))).filter(
      (tool): tool is Tool.Info => Boolean(tool),
    )
    // Use allSettled to avoid one tool's init failure blocking all tools
    const initResults = await Promise.allSettled(
      tools.map(async (t) => {
        const def = await t.init({ agent })
        return {
          id: t.id,
          exposure: ToolExposure.normalize(t.id, t.exposure),
          display: t.display,
          source: t.source,
          inputSchema: t.inputSchema,
          ...def,
        }
      }),
    )

    const result = []
    for (let i = 0; i < initResults.length; i++) {
      const item = initResults[i]
      if (item.status === "fulfilled") {
        result.push(item.value)
      } else {
        log.warn("tool skipped due to init failure", { tool: tools[i]?.id, error: String(item.reason) })
      }
    }
    return result
  }
}
