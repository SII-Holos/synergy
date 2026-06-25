import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { ViewFileTool } from "./view-file"
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
import { BlueprintLoopFinishTool } from "./blueprint-loop-finish"
import { BlueprintLoopRestartTool } from "./blueprint-loop-restart"
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

import { InvalidTool } from "./invalid"
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
import { type ToolDefinition } from "@ericsanchezok/synergy-plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { PluginToolId } from "../plugin/ids.js"
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
import { SearchToolsTool } from "./search-tools"
import { ExpandToolsTool } from "./expand-tools"
import { WorktreeEnterTool } from "./worktree-enter"
import { WorktreeLeaveTool } from "./worktree-leave"
import { WorktreeListTool } from "./worktree-list"
import { BrowserAnnotateTool } from "./browser-annotate"
import { BrowserNavigateTool } from "./browser-navigate"
import { BrowserSnapshotTool } from "./browser-snapshot"
import { BrowserScreenshotTool } from "./browser-screenshot"
import { BrowserInspectTool } from "./browser-inspect"
import { BrowserWaitTool } from "./browser-wait"
import { BrowserClickTool } from "./browser-click"
import { BrowserTypeTool } from "./browser-type"
import { BrowserScrollTool } from "./browser-scroll"
import { BrowserTabTool } from "./browser-tab"
import { BrowserConsoleTool } from "./browser-console"
import { BrowserNetworkTool } from "./browser-network"
import { BrowserDownloadTool } from "./browser-download"
import { BrowserDownloadsTool } from "./browser-downloads"
import { BrowserViewportTool } from "./browser-viewport"
import { BrowserReadTool } from "./browser-read"
import { BrowserClipboardTool } from "./browser-clipboard"
import { BrowserListTool } from "./browser-list"
import { BrowserNavigationTool } from "./browser-navigation"
import { BrowserActionTool } from "./browser-action"
import { BrowserEvalTool } from "./browser-eval"
import { BrowserViewTool } from "./browser-view"
import { BrowserAssetsTool } from "./browser-assets"
import { ToolExposure } from "./exposure"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  export const state = ScopedState.create(async () => {
    const custom = [] as Tool.Info[]
    const glob = new Bun.Glob("tool/*.{js,ts}")

    for (const dir of await Config.directories()) {
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
      const manifest = await Plugin.manifest(plugin.id).catch(() => null)
      for (const [id, def] of Object.entries(plugin.hooks.tool ?? {})) {
        const exposure = pluginToolExposure(def, id, manifest)
        const runtime = getRuntime(plugin.id)
        const runtimeMode = plugin.runtimeMode ?? runtime?.mode ?? "in-process"
        if (runtimeMode !== "in-process") {
          custom.push(fromRuntimePlugin(id, def, plugin.id, exposure))
        } else {
          custom.push(fromPlugin(id, def, plugin.id, exposure))
        }
      }
    }

    return { custom }
  })

  export async function reload() {
    log.info("reloading tool registry state")
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
    const manifestTool = manifest?.contributes?.tools?.find((tool) => tool.id === id || tool.name === id)
    return manifestTool?.exposure as ToolExposure.Info | undefined
  }

  function fromPlugin(id: string, def: ToolDefinition, pluginId?: string, exposure?: ToolExposure.Info): Tool.Info {
    const fullId = pluginId ? PluginToolId.format(pluginId, id) : id
    return {
      id: fullId,
      exposure,
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

  function fromRuntimePlugin(
    id: string,
    def: ToolDefinition,
    pluginId: string,
    exposure?: ToolExposure.Info,
  ): Tool.Info {
    const fullId = PluginToolId.format(pluginId, id)
    return {
      id: fullId,
      exposure,
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const raw = await invokeRuntimeTool(pluginId, id, args, {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            agent: ctx.agent,
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
    const config = await Config.current()

    return [
      InvalidTool,
      ...(Flag.SYNERGY_CLIENT === "cli" ? [QuestionTool] : []),
      BashTool,
      ProcessTool,
      ConnectTool,
      ReadTool,
      ViewFileTool,
      ScanFilesTool,
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
      NoteListTool,
      NoteReadTool,
      NoteSearchTool,
      NoteWriteTool,
      NoteEditTool,
      BlueprintLoopFinishTool,
      BlueprintLoopRestartTool,
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
      BrowserNavigateTool,
      BrowserSnapshotTool,
      BrowserScreenshotTool,
      BrowserInspectTool,
      BrowserWaitTool,
      BrowserClickTool,
      BrowserTypeTool,
      BrowserScrollTool,
      BrowserTabTool,
      BrowserConsoleTool,
      BrowserNetworkTool,
      BrowserDownloadTool,
      BrowserDownloadsTool,
      BrowserViewportTool,
      BrowserReadTool,
      BrowserClipboardTool,
      BrowserListTool,
      BrowserNavigationTool,
      BrowserAssetsTool,
      BrowserActionTool,
      BrowserEvalTool,
      BrowserViewTool,
      ...(Flag.SYNERGY_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...custom,
    ]
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
        return { id: t.id, exposure: ToolExposure.normalize(t.id, t.exposure), ...def }
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
