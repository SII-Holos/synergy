import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
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
import { ProfileGetTool, ProfileUpdateTool } from "./profile"
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
import { AgoraSearchTool } from "./agora-search"
import { AgoraReadTool } from "./agora-read"
import { AgoraPostTool } from "./agora-post"
import { AgoraJoinTool } from "./agora-join"
import { AgoraSyncTool } from "./agora-sync"
import { AgoraSubmitTool } from "./agora-submit"
import { AgoraAcceptTool } from "./agora-accept"
import { AgoraCommentTool } from "./agora-comment"
import { AttachTool } from "./attach"

import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import { LookAtTool } from "./lookat"
import { AstGrepTool } from "./ast-grep"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../scope/instance"
import { Config } from "../config/config"
import path from "path"
import { type ToolDefinition } from "@ericsanchezok/synergy-plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { WebSearchTool } from "./websearch"
import { ArxivSearchTool, ArxivDownloadTool } from "./arxiv"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { ProcessTool } from "./process"
import { ConnectTool } from "./connect"
import { Truncate } from "./truncation"
import { DiagramTool } from "./diagram"
import { EmailTool } from "./email"
import { EmailReadTool } from "./email-read"
import { RuntimeReloadTool } from "./runtime-reload"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  export const state = Instance.state(async () => {
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
          custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
        }
      }
    }

    const plugins = await Plugin.list()
    for (const plugin of plugins) {
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        custom.push(fromPlugin(id, def))
      }
    }

    return { custom }
  })

  export async function reload() {
    log.info("reloading tool registry state")
    await state.resetAll()
    log.info("tool registry state reloaded")
  }

  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const pluginCtx = {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            agent: ctx.agent,
            abort: ctx.abort,
            directory: Instance.directory,
            ask: (input: { permission: string; patterns: string[]; metadata?: Record<string, any> }) =>
              ctx.ask({ ...input, metadata: input.metadata ?? {} }),
          }
          const raw = await def.execute(args as any, pluginCtx)
          if (typeof raw === "object" && raw !== null && "output" in raw) {
            const structured = raw as { title?: string; output: string; metadata?: Record<string, any> }
            const out = await Truncate.output(structured.output, {}, initCtx?.agent)
            return {
              title: structured.title ?? "",
              output: out.truncated ? out.content : structured.output,
              metadata: {
                ...structured.metadata,
                truncated: out.truncated,
                outputPath: out.truncated ? out.outputPath : undefined,
              },
            }
          }
          const text = raw as string
          const out = await Truncate.output(text, {}, initCtx?.agent)
          return {
            title: "",
            output: out.truncated ? out.content : text,
            metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
          }
        },
      }),
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
    const config = await Config.get()

    return [
      InvalidTool,
      ...(Flag.SYNERGY_CLIENT === "cli" ? [QuestionTool] : []),
      BashTool,
      ProcessTool,
      ConnectTool,
      ReadTool,
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
      ArxivSearchTool,
      ArxivDownloadTool,
      SkillTool,
      LookAtTool,
      AstGrepTool,
      MemoryWriteTool,
      MemoryEditTool,
      MemorySearchTool,
      MemoryGetTool,
      NoteListTool,
      NoteReadTool,
      NoteSearchTool,
      NoteWriteTool,
      ProfileGetTool,
      ProfileUpdateTool,
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
      AgoraSearchTool,
      AgoraReadTool,
      AgoraPostTool,
      AgoraJoinTool,
      AgoraSyncTool,
      AgoraSubmitTool,
      AgoraAcceptTool,
      AgoraCommentTool,
      AttachTool,
      DiagramTool,
      EmailTool,
      EmailReadTool,
      RuntimeReloadTool,
      ...(Flag.SYNERGY_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
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
        return { id: t.id, ...def }
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
