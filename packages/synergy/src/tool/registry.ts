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
import { PathwayPatchTool } from "./pathway-patch"
import { SessionListTool } from "./session-list"
import { SessionReadTool } from "./session-read"
import { SessionSearchTool } from "./session-search"
import { SessionSendTool } from "./session-send"
import { SessionControlTool } from "./session-control"
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
import { type ToolDefinition, type ToolDisplay } from "@ericsanchezok/synergy-plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { PluginToolId } from "../plugin/ids.js"
import { createPluginToolContext } from "../plugin/host-services"
import { getRuntime, invokeRuntimeTool } from "../plugin-runtime/supervisor"
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

    const plugins = await Plugin.perPluginHooks()
    for (const plugin of plugins) {
      try {
        const manifest = plugin.manifest
        for (const [id, def] of Object.entries(plugin.hooks.tool ?? {})) {
          const exposure = pluginToolExposure(def, id, manifest)
          const display = pluginToolDisplay(def, id, manifest)
          const runtime = getRuntime(plugin.id)
          const runtimeMode = plugin.runtimeMode ?? runtime?.mode ?? "in-process"
          if (runtimeMode !== "in-process") {
            custom.push(fromRuntimePlugin(id, def, plugin.id, plugin.pluginDir, runtimeMode, exposure, display))
          } else {
            custom.push(fromPlugin(id, def, plugin.id, plugin.pluginDir, runtimeMode, exposure, display))
          }
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

  function pluginToolExposure(
    def: ToolDefinition,
    id: string,
    manifest: Awaited<ReturnType<typeof Plugin.manifest>>,
  ): ToolExposure.Info | undefined {
    const explicit = (def as ToolDefinition & { exposure?: ToolExposure.Info }).exposure
    if (explicit) return explicit
    const manifestTool = manifest?.contributes?.tools?.find(
      (tool: { id?: string; name?: string }) => tool.id === id || tool.name === id,
    )
    return manifestTool?.exposure as ToolExposure.Info | undefined
  }

  function pluginToolDisplay(
    def: ToolDefinition,
    id: string,
    manifest: Awaited<ReturnType<typeof Plugin.manifest>>,
  ): ToolDisplay | undefined {
    const manifestTool = manifest?.contributes?.tools?.find(
      (tool: { id?: string; name?: string }) => tool.id === id || tool.name === id,
    )
    const manifestDisplay = manifestTool?.display as ToolDisplay | undefined
    const explicit = (def as ToolDefinition & { display?: ToolDisplay }).display
    if (!explicit) return manifestDisplay
    const media = (
      manifestDisplay?.media || explicit.media
        ? {
            ...manifestDisplay?.media,
            ...explicit.media,
          }
        : undefined
    ) as ToolDisplay["media"]
    return {
      ...manifestDisplay,
      ...explicit,
      ...(media ? { media } : {}),
    }
  }

  function fromPlugin(
    id: string,
    def: ToolDefinition,
    pluginId?: string,
    pluginDir?: string,
    runtimeMode: "in-process" | "worker" | "process" = "in-process",
    exposure?: ToolExposure.Info,
    display?: ToolDisplay,
  ): Tool.Info {
    const fullId = pluginId ? PluginToolId.format(pluginId, id) : id
    return {
      id: fullId,
      exposure,
      display: display ?? (def as ToolDefinition & { display?: ToolDisplay }).display,
      source: pluginId ? { type: "plugin", pluginId, toolId: id, pluginDir, runtimeMode } : { type: "local" },
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const pluginCtx =
            pluginId && pluginDir
              ? createPluginToolContext({
                  pluginId,
                  pluginDir,
                  toolId: id,
                  context: ctx,
                  directory: ScopeContext.current.directory,
                })
              : {
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

  function fromRuntimePlugin(
    id: string,
    def: ToolDefinition,
    pluginId: string,
    _pluginDir: string,
    runtimeMode: "in-process" | "worker" | "process",
    exposure?: ToolExposure.Info,
    display?: ToolDisplay,
  ): Tool.Info {
    const fullId = PluginToolId.format(pluginId, id)
    return {
      id: fullId,
      exposure,
      display: display ?? (def as ToolDefinition & { display?: ToolDisplay }).display,
      source: { type: "plugin", pluginId, toolId: id, pluginDir: _pluginDir, runtimeMode },
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const raw = await invokeRuntimeTool(
            pluginId,
            id,
            args,
            {
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              agent: ctx.agent,
              directory: ScopeContext.current.directory,
              callID: ctx.callID,
              toolId: id,
            },
            ctx.abort,
          )
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
      PathwayPatchTool,
      SessionListTool,
      SessionReadTool,
      SessionSearchTool,
      SessionSendTool,
      SessionControlTool,
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
    return all().then((x) => x.map((t) => t.id))
  }

  const findCache = new Map<string, { id: string; description: string; parameters: any; execute: Function }>()

  export async function find(id: string) {
    const cached = findCache.get(id)
    if (cached) return cached

    const tools = await all()
    const tool = tools.find((t) => t.id === id)
    if (!tool) return undefined
    const def = await tool.init()
    const result = { id: tool.id, ...def }
    findCache.set(id, result)
    return result
  }

  export async function tools(providerID: string, agent?: Agent.Info) {
    const tools = await all()
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
