import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { FileSearchTool } from "./file-search"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { ViewFileTool } from "./view-file"
import { ViewImageTool } from "./view-image"
import { ReviseFileTool } from "./revise-file"
import { SaveFileTool } from "./save-file"
import { ScanFilesTool } from "./scan-files"
import { ParseCodeTool } from "./parse-code"
import { TaskTool } from "./task"
import { TaskListTool } from "./task-list"
import { TaskOutputTool } from "./task-output"
import { TaskCancelTool } from "./task-cancel"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { DagWriteTool, DagReadTool, DagPatchTool } from "./dag"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { MemoryWriteTool, MemoryEditTool, MemorySearchTool, MemoryGetTool } from "./memory"
import { NoteListTool } from "./note-list"
import { NoteReadTool } from "./note-read"
import { NoteSearchTool } from "./note-search"
import { NoteWriteTool } from "./note-write"
import { NoteEditTool } from "./note-edit"
import { NoteArchiveTool } from "./note-archive"
import { NoteDeleteTool } from "./note-delete"
import { BlueprintLoopStopTool } from "./blueprint-loop-stop"
import { BlueprintLoopApproveTool } from "./blueprint-loop-approve"
import { BlueprintLoopRejectTool } from "./blueprint-loop-reject"
import { LoopStopTool } from "./loop-stop"
import { LightLoopApproveTool } from "./light-loop-approve"
import { LightLoopRejectTool } from "./light-loop-reject"
import { PathwayReadTool } from "./pathway-read"
import { PathwayWriteTool } from "./pathway-write"
import { LatticeSubmitTool } from "./lattice-submit"
import { SessionListTool } from "./session-list"
import { SessionReadTool } from "./session-read"
import { SessionSearchTool } from "./session-search"
import { SessionSendTool } from "./session-send"
import { SessionControlTool } from "./session-control"
import { ScopeListTool } from "./scope-list"
import { AgendaScheduleTool } from "./agenda-schedule"
import { AgendaWatchTool } from "./agenda-watch"
import { AgendaListTool } from "./agenda-list"
import { AgendaUpdateTool } from "./agenda-update"
import { AgendaCancelTool } from "./agenda-cancel"
import { AgendaTriggerTool } from "./agenda-trigger"
import { AgendaLogsTool } from "./agenda-logs"
// import { AgoraSearchTool } from "./agora-search"
// import { AgoraReadTool } from "./agora-read"
// import { AgoraPostTool } from "./agora-post"
// import { AgoraJoinTool } from "./agora-join"
// import { AgoraSyncTool } from "./agora-sync"
// import { AgoraSubmitTool } from "./agora-submit"
// import { AgoraAcceptTool } from "./agora-accept"
// import { AgoraCommentTool } from "./agora-comment"
import { AttachTool } from "./attach"
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
import { Plugin } from "../plugin"
import { PluginToolId } from "../plugin/ids.js"
import { ensureRuntime, type LoadedPlugin } from "../plugin/loader"
import { pluginRuntimeManager } from "../plugin/runtime"
import { WebSearchTool } from "./websearch"
import { ArxivSearchTool, ArxivDownloadTool } from "./arxiv"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { ProcessTool } from "./process"
import { ConnectTool } from "./connect"
import { Truncate } from "./truncation"
// 🔇 import { DiagramTool } from "./diagram"  — 已注释，待重构
import { RenderTool } from "./render"
import { EmailSendTool } from "./email"
import { EmailReadTool } from "./email-read"
import { RuntimeReloadTool } from "./runtime-reload"
import { CodexProvider } from "@/provider/codex"
import { SearchToolsTool } from "./search-tools"
import { ExpandToolsTool } from "./expand-tools"
import { WorktreeEnterTool } from "./worktree-enter"
import { WorktreeLeaveTool } from "./worktree-leave"
import { WorktreeListTool } from "./worktree-list"
import { BrowserAnnotateTool } from "./browser-annotate"
import { BrowserSnapshotTool } from "./browser-snapshot"
import { BrowserScreenshotTool } from "./browser-screenshot"
import { BrowserInspectTool } from "./browser-inspect"
import { BrowserWaitTool } from "./browser-wait"
import { BrowserConsoleTool } from "./browser-console"
import { BrowserNetworkTool } from "./browser-network"
import { BrowserDownloadsTool } from "./browser-downloads"
import { BrowserReadTool } from "./browser-read"
import { BrowserClipboardTool } from "./browser-clipboard"
import { BrowserNavigationTool } from "./browser-navigation"
import { BrowserActionTool } from "./browser-action"
import { BrowserEvalTool } from "./browser-eval"
import { BrowserViewTool } from "./browser-view"
import { BrowserAssetsTool } from "./browser-assets"
import { BrowserPerformanceTool } from "./browser-performance"
import { BrowserAuditTool } from "./browser-audit"
import { BrowserEmulateTool } from "./browser-emulate"
import { BrowserDialogTool } from "./browser-dialog"
import { BrowserUploadTool } from "./browser-upload"
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

    const plugins = await Plugin.getLoaded()
    for (const plugin of plugins) {
      try {
        for (const contribution of Plugin.contributions(plugin, "tool")) {
          custom.push(fromRuntimePlugin(contribution, plugin))
        }
      } catch (err) {
        log.warn("plugin tools skipped due to registry failure", {
          pluginId: plugin.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
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

  export function matchesSettingCondition(
    condition: { setting: string; equals: string | number | boolean },
    values: Record<string, unknown>,
  ): boolean {
    return values[condition.setting] === condition.equals
  }

  async function conditionEnabled(
    pluginId: string,
    condition: { setting: string; equals: string | number | boolean },
  ): Promise<boolean> {
    const domain = await Config.domainGet("plugins")
    const values = domain.pluginConfig?.[pluginId]
    if (!values || typeof values !== "object" || Array.isArray(values)) return false
    return matchesSettingCondition(condition, values as Record<string, unknown>)
  }

  async function enabled(tool: Tool.Info): Promise<boolean> {
    if (!tool.enabledWhen) return true
    if (tool.source?.type !== "plugin") return false
    return conditionEnabled(tool.source.pluginId, tool.enabledWhen)
  }

  function fromRuntimePlugin(
    contribution: Extract<LoadedPlugin["manifest"]["contributions"][number], { kind: "tool" }>,
    plugin: LoadedPlugin,
  ): Tool.Info {
    const fullId = PluginToolId.format(plugin.id, contribution.id)
    return {
      id: fullId,
      exposure: contribution.exposure as ToolExposure.Info | undefined,
      display: contribution.display as ToolDisplay | undefined,
      source: {
        type: "plugin",
        pluginId: plugin.id,
        toolId: contribution.id,
        pluginDir: plugin.pluginDir,
        runtimeMode: "process",
      },
      inputSchema: contribution.input,
      enabledWhen: contribution.enabledWhen,
      init: async (initCtx) => ({
        parameters: manifestParameters(contribution.input),
        description: contribution.description,
        execute: async (args, ctx) => {
          if (contribution.enabledWhen && !(await conditionEnabled(plugin.id, contribution.enabledWhen))) {
            throw Object.assign(new Error(`Plugin tool ${fullId} is disabled by plugin settings.`), {
              code: "CONTRIBUTION_DISABLED",
            })
          }
          await ensureRuntime(plugin)
          const raw = await pluginRuntimeManager.invoke({
            pluginId: plugin.id,
            handlerId: `tool:${contribution.id}`,
            value: args,
            context: {
              scopeId: ScopeContext.current.scope.id,
              sessionId: ctx.sessionID,
              directory: ScopeContext.current.directory,
              actor: {
                type: "agent",
                agent: ctx.agent,
                messageId: ctx.messageID,
                callId: ctx.callID ?? `${plugin.id}:${contribution.id}`,
              },
            },
            pluginDir: plugin.pluginDir,
            manifest: plugin.manifest,
            signal: ctx.abort,
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
      ...(Flag.SYNERGY_CLIENT === "cli" ? [QuestionTool] : []),
      BashTool,
      ProcessTool,
      ConnectTool,
      ReadTool,
      ViewImageTool,
      ViewFileTool,
      ScanFilesTool,
      FileSearchTool,
      ParseCodeTool,
      ReviseFileTool,
      SaveFileTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      TaskTool,
      TaskListTool,
      TaskOutputTool,
      TaskCancelTool,
      WebFetchTool,
      TodoWriteTool,
      TodoReadTool,
      DagWriteTool,
      DagReadTool,
      DagPatchTool,
      WebSearchTool,
      SearchToolsTool,
      ExpandToolsTool,
      ArxivSearchTool,
      ArxivDownloadTool,
      SkillTool,
      LookAtTool,
      ScanDocumentTool,
      AstGrepTool,
      MemoryWriteTool,
      MemoryEditTool,
      MemorySearchTool,
      MemoryGetTool,
      NoteArchiveTool,
      NoteListTool,
      NoteReadTool,
      NoteSearchTool,
      NoteWriteTool,
      NoteEditTool,
      NoteDeleteTool,
      BlueprintLoopStopTool,
      BlueprintLoopApproveTool,
      BlueprintLoopRejectTool,
      LoopStopTool,
      LightLoopApproveTool,
      LightLoopRejectTool,
      PathwayReadTool,
      PathwayWriteTool,
      LatticeSubmitTool,
      SessionListTool,
      SessionReadTool,
      SessionSearchTool,
      SessionSendTool,
      SessionControlTool,
      ScopeListTool,
      AgendaScheduleTool,
      AgendaWatchTool,
      AgendaListTool,
      AgendaUpdateTool,
      AgendaCancelTool,
      AgendaTriggerTool,
      AgendaLogsTool,
      //       AgoraSearchTool,
      //       AgoraReadTool,
      //       AgoraPostTool,
      //       AgoraJoinTool,
      //       AgoraSyncTool,
      //       AgoraSubmitTool,
      //       AgoraAcceptTool,
      //       AgoraCommentTool,
      AttachTool,
      // 🔇 DiagramTool,  — 已注释，待重构
      RenderTool,
      EmailSendTool,
      EmailReadTool,
      RuntimeReloadTool,
      WorktreeEnterTool,
      WorktreeLeaveTool,
      WorktreeListTool,
      BrowserAnnotateTool,
      BrowserSnapshotTool,
      BrowserScreenshotTool,
      BrowserInspectTool,
      BrowserWaitTool,
      BrowserConsoleTool,
      BrowserNetworkTool,
      BrowserDownloadsTool,
      BrowserReadTool,
      BrowserClipboardTool,
      BrowserNavigationTool,
      BrowserAssetsTool,
      BrowserActionTool,
      BrowserEvalTool,
      BrowserViewTool,
      BrowserPerformanceTool,
      BrowserAuditTool,
      BrowserEmulateTool,
      BrowserDialogTool,
      BrowserUploadTool,
      ...(Flag.SYNERGY_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
    ]

    const codexAccess = await CodexProvider.resolveToken({
      allowMissing: true,
      refreshIfExpiring: false,
    }).catch(() => undefined)
    if (codexAccess) builtin.push(OpenAIImageGenTool, OpenAIImageEditTool)

    return [...builtin, ...custom]
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
        using _ = log.time(t.id)
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
