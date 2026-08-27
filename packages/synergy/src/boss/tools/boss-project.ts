import path from "path"
import { mkdir } from "fs/promises"
import { existsSync } from "fs"
import z from "zod"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { Session } from "../../session"
import { SessionInteraction } from "../../session/interaction"
import { Agent } from "../../agent/agent"
import { Tool } from "../../tool/tool"
import DESCRIPTION from "./boss-project.txt"

const parameters = z.object({
  directory: z.string().min(1).describe("Absolute path of the project directory to create/bind."),
  title: z.string().optional().describe("Title of the project boss session. Defaults to the directory basename."),
  agent: z.string().optional().describe("Agent to run the project boss session. Defaults to the session's agent."),
  instructions: z
    .string()
    .optional()
    .describe(
      "Optional standing instructions for the project boss. When omitted, the default layered-reporting discipline is used.",
    ),
})

/** Default layered-reporting discipline written into every project boss. */
export const DEFAULT_PROJECT_BOSS_INSTRUCTIONS = [
  "你是这个项目的负责人(项目 boss)。你的直属信息源是 worker 的 boss_report 汇报。",
  "分层汇报纪律:只向总 boss(运行时 boss)发送摘要——状态变更(开始/完成/阻塞/需决策)、一句结果、一个 sessionID 引用;",
  "不转发 worker 原始汇报全文。用 session_send 把摘要投递给总 boss。",
  "总 boss 需要细节时,它会用 session_read 深读本会话或 worker 历史。",
  "重要事实(任务状态、决策、约束)用 memory_write 固化,compaction 只折叠消息历史。",
].join("\n")

export const BossProjectTool = Tool.define("boss_project", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const directory = path.resolve(params.directory)

    const caller = await Session.get(ctx.sessionID)
    const isBossRole = caller?.workflow?.kind === "boss" && caller?.workflow?.role === "boss"
    if (!isBossRole) {
      throw new Error("boss_project: only boss-role sessions may create project bosses")
    }

    // 1. Authorize binding this directory as a project scope whether or not
    // it already exists — an existing arbitrary absolute path otherwise
    // becomes a trusted project scope with no permission decision.
    await ctx.ask({ permission: "external_directory", patterns: [directory], metadata: { directory } })
    if (!existsSync(directory)) {
      await mkdir(directory, { recursive: true })
    }

    // 2. Bind the directory as a project Scope (idempotent: existing scope reused).
    const { scope } = await Scope.fromDirectory(directory, { persist: true })
    if (scope.type !== "project") {
      throw new Error(`boss_project: "${directory}" did not resolve to a project Scope`)
    }

    // 3. Create the project boss session in that scope.
    const title = params.title?.trim() || path.basename(directory)
    const agent = params.agent?.trim() || caller?.agentOverride || "synergy"
    const agentInfo = await Agent.get(agent).catch(() => undefined)
    if (!agentInfo) {
      throw new Error(`boss_project: unknown agent "${agent}"`)
    }
    const instructions = [
      params.instructions?.trim() || DEFAULT_PROJECT_BOSS_INSTRUCTIONS,
      "",
      `协调者(总 boss)sessionID: ${caller.id}。用 session_send 向它发送摘要;它用 session_read 深读你的会话。`,
    ].join("\n")
    const session = await ScopeContext.provide({
      scope,
      fn: () =>
        Session.create({
          scope,
          title,
          agentOverride: agent,
          interaction: SessionInteraction.interactive("boss"),
          workflow: { kind: "boss", role: "boss", instructions },
        }),
    })

    return {
      title: `Project boss created: ${title}`,
      metadata: { sessionID: session.id, scopeID: scope.id, directory },
      output: `Created project boss session ${session.id} for ${directory} (scope ${scope.id}). Use session_send to hand it work; it reports back with summaries.`,
    }
  },
})
