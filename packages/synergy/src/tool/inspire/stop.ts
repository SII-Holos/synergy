import z from "zod"
import { Tool } from "../tool"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { InspireNormalize } from "./normalize"
import { InspireResolve } from "./resolve"

const DESCRIPTION = `Stop running tasks on the SII 启智平台. Uses the official OpenAPI. Supports stopping a single task by ID or batch-stopping all tasks matching a status filter in a workspace.

Use job_id to stop a single task, or workspace + status to stop multiple tasks at once.`

const parameters = z.object({
  job_id: z.string().optional().describe("Task ID to stop. Mutually exclusive with workspace parameter"),
  workspace: z
    .string()
    .optional()
    .describe("Stop all matching tasks in this workspace (name or ID). Mutually exclusive with job_id"),
  status: z
    .string()
    .optional()
    .describe(
      "Status filter for batch stop (default 'running'). Only used with workspace parameter. Options: 'running', 'waiting', 'all'",
    ),
})

export const InspireStopTool = Tool.define("inspire_stop", {
  description: DESCRIPTION,
  parameters,
  async execute(params) {
    if (!params.job_id && !params.workspace) {
      return {
        title: "参数错误",
        output: "请指定 job_id（停止单个任务）或 workspace（批量停止）",
        metadata: { error: "missing_parameters" } as Record<string, any>,
      }
    }

    // Obtain OpenAPI token — write operations must use the official API
    let token: string
    try {
      token = await InspireAuth.ensureToken()
    } catch (err: any) {
      if (err instanceof InspireAuth.TokenUnavailableError) {
        if (err.reason === "not_authenticated") {
          return InspireAuth.notAuthenticatedError("inspire")
        }
        if (err.reason === "openapi_not_enabled") {
          return {
            title: "OpenAPI 权限未开通",
            output: ["当前账号未开通 OpenAPI 权限，无法停止任务。", "", "请联系平台管理员开通 OpenAPI 权限。"].join(
              "\n",
            ),
            metadata: { error: "openapi_not_enabled" } as Record<string, any>,
          }
        }
        return {
          title: "停止失败",
          output: `OpenAPI 认证失败: ${err.message}`,
          metadata: { error: "token_unavailable", reason: err.reason } as Record<string, any>,
        }
      }
      return {
        title: "认证失败",
        output: `无法获取 OpenAPI Token: ${err.message ?? err}`,
        metadata: { error: "token_error" } as Record<string, any>,
      }
    }

    if (params.job_id) {
      try {
        await InspireAuth.withTokenRetry((t) => InspireAPI.stopJobOpenAPI(t, params.job_id!))
        return {
          title: `已停止 ${params.job_id}`,
          output: `✅ 任务 ${params.job_id} 已停止`,
          metadata: { job_id: params.job_id, action: "stopped" } as Record<string, any>,
        }
      } catch (err: any) {
        return {
          title: "停止失败",
          output: `无法停止任务 ${params.job_id}: ${err.message ?? err}`,
          metadata: { error: "stop_failed", job_id: params.job_id } as Record<string, any>,
        }
      }
    }

    // Batch stop: list jobs (read via Cookie API), then stop each via OpenAPI
    try {
      const ws = await InspireResolve.workspace(params.workspace!)
      if (!ws) {
        return {
          title: "空间未找到",
          output: `未找到工作空间: ${params.workspace}`,
          metadata: { error: "workspace_not_found" } as Record<string, any>,
        }
      }

      const statusFilter = params.status ?? "running"
      const { jobs } = await InspireAuth.withCookieRetry((cookie) => InspireAPI.listJobsWithCookie(cookie, ws.id))

      const matching = jobs.filter((job) => {
        const normalized = InspireNormalize.status(job.status ?? "")
        if (statusFilter === "all") return !normalized.is_terminal
        return normalized.family === statusFilter
      })

      if (matching.length === 0) {
        return {
          title: "无匹配任务",
          output: `空间 "${ws.name}" 中没有状态为 ${statusFilter} 的任务`,
          metadata: { workspace: ws.name, workspace_id: ws.id, filter: statusFilter, count: 0 } as Record<string, any>,
        }
      }

      const results: Array<{ name: string; id: string; success: boolean }> = []
      for (const job of matching) {
        const jobId = job.job_id ?? job.id
        const jobName = job.name ?? jobId
        try {
          await InspireAuth.withTokenRetry((t) => InspireAPI.stopJobOpenAPI(t, jobId))
          results.push({ name: jobName, id: jobId, success: true })
        } catch {
          results.push({ name: jobName, id: jobId, success: false })
        }
      }

      const successCount = results.filter((r) => r.success).length
      const lines = [
        "=== 批量停止任务 ===",
        "",
        `空间: ${ws.name}`,
        `停止条件: 状态为 ${statusFilter}`,
        "",
        `停止了 ${matching.length} 个任务:`,
      ]

      for (const r of results) {
        const icon = r.success ? "✅" : "❌"
        const msg = r.success ? "已停止" : "停止失败"
        lines.push(`  ${icon} ${r.name} (${r.id}) — ${msg}`)
      }

      lines.push("", `成功: ${successCount} / ${results.length}`)

      return {
        title: `停止 ${successCount}/${results.length} 任务`,
        output: lines.join("\n"),
        metadata: {
          workspace: ws.name,
          workspace_id: ws.id,
          filter: statusFilter,
          total: results.length,
          success: successCount,
          failed: results.length - successCount,
        } as Record<string, any>,
      }
    } catch (err: any) {
      if (String(err).includes("inspire_not_authenticated")) {
        return InspireAuth.notAuthenticatedError("inspire")
      }
      throw err
    }
  },
})
