import z from "zod"
import { Tool } from "../tool"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { InspireNormalize } from "./normalize"
import { InspireResolve } from "./resolve"
import { InspireCache } from "./cache"
import { InspireTypes } from "./types"
import { STATUS_LABELS, requireWorkspace } from "./shared"

const DESCRIPTION = `List training and HPC tasks on the SII 启智平台 with status filtering and pagination.

Status filtering uses normalized status families (you don't need to know the platform's raw status values):
- running: currently executing
- waiting: queued, creating, or scheduling
- succeeded: completed successfully
- failed: crashed or errored
- stopped: manually stopped or cancelled
- all: show all statuses (default)

Returns a summary with status counts and a formatted task list. Use inspire_job_detail for full details on a specific task.`

const parameters = z.object({
  workspace: z.string().optional().describe("Filter to a workspace (name or ID). Omit to check all cached workspaces"),
  project: z.string().optional().describe("Filter to a specific project (name or ID)"),
  status: z
    .string()
    .optional()
    .describe("Status filter: running, waiting, succeeded, failed, stopped, all (default: all)"),
  type: z.string().optional().describe("Task type: gpu, hpc, all (default: all)"),
  limit: z.number().optional().describe("Max results to return (default 20)"),
  offset: z.number().optional().describe("Pagination offset (default 0)"),
})

export const InspireJobsTool = Tool.define("inspire_jobs", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const statusFilter = params.status ?? "all"
    const typeFilter = params.type ?? "all"
    const limit = params.limit ?? 20
    const offset = params.offset ?? 0

    let workspaceIds: { id: string; name: string }[] = []

    if (params.workspace) {
      const wsResult = await requireWorkspace(params.workspace)
      if (!("ws" in wsResult)) return wsResult
      workspaceIds = [wsResult.ws]
    } else {
      const projects = await InspireCache.getProjects()
      const seen = new Set<string>()
      for (const proj of projects) {
        for (const space of proj.space_list ?? []) {
          if (!seen.has(space.id)) {
            seen.add(space.id)
            workspaceIds.push({ id: space.id, name: space.name })
          }
        }
      }
    }

    // Resolve project filter once for client-side filtering
    let projectFilter: { id: string } | undefined
    if (params.project) {
      const resolved = await InspireResolve.project(params.project)
      if (resolved) projectFilter = { id: resolved.id }
    }

    interface JobEntry {
      name: string
      job_id: string
      status: InspireTypes.StatusFamily
      workspace_name: string
      project_name: string
      project_id: string
      gpu_count: number
      priority: string
      created_at: string
      running_time_ms?: string
      type: "gpu" | "hpc"
    }

    const allJobs: JobEntry[] = []
    const statusCounts: Record<string, number> = {}
    let totalCount = 0

    for (const ws of workspaceIds) {
      if (typeFilter !== "hpc") {
        try {
          const { jobs, total } = await InspireAuth.withCookieRetry((cookie) =>
            InspireAPI.listJobsWithCookie(cookie, ws.id, { pageSize: 100 }),
          )
          for (const job of jobs) {
            const s = InspireNormalize.status(job.status ?? "")
            const family = s.family
            statusCounts[family] = (statusCounts[family] ?? 0) + 1
            totalCount++

            if (statusFilter !== "all" && family !== statusFilter) continue
            if (projectFilter && job.project_id !== projectFilter.id) continue

            const info = InspireAPI.extractGpuInfo(job)
            allJobs.push({
              name: job.name ?? job.job_name ?? "",
              job_id: job.job_id ?? job.id ?? "",
              status: s,
              workspace_name: ws.name,
              project_name: job.project_name ?? "",
              project_id: job.project_id ?? "",
              gpu_count: info.gpu_count,
              priority: job.priority_name ?? job.priority ?? "",
              created_at: job.created_at ?? "",
              running_time_ms: job.running_time_ms,
              type: "gpu",
            })
          }
        } catch (err: any) {
          if (String(err).includes("inspire_not_authenticated")) {
            return InspireAuth.notAuthenticatedError("inspire")
          }
        }
      }

      if (typeFilter !== "gpu") {
        try {
          const { jobs } = await InspireAuth.withCookieRetry((cookie) => InspireAPI.listHpcJobs(cookie, ws.id))
          for (const job of jobs) {
            const s = InspireNormalize.status(job.status ?? "")
            statusCounts[s.family] = (statusCounts[s.family] ?? 0) + 1
            totalCount++

            if (statusFilter !== "all" && s.family !== statusFilter) continue
            if (projectFilter && job.project_id !== projectFilter.id) continue

            allJobs.push({
              name: job.job_name ?? job.name ?? "",
              job_id: job.job_id ?? job.id ?? "",
              status: s,
              workspace_name: ws.name,
              project_name: job.project_name ?? "",
              project_id: job.project_id ?? "",
              gpu_count: 0,
              priority: "",
              created_at: job.created_at ?? "",
              type: "hpc",
            })
          }
        } catch {}
      }
    }

    allJobs.sort((a, b) => {
      const order = { running: 0, waiting: 1, failed: 2, succeeded: 3, stopped: 4, unknown: 5 }
      const diff = (order[a.status.family] ?? 5) - (order[b.status.family] ?? 5)
      if (diff !== 0) return diff
      return (b.created_at ?? "").localeCompare(a.created_at ?? "")
    })

    const page = allJobs.slice(offset, offset + limit)

    const statusSummary = Object.entries(statusCounts)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")

    const filterParts: string[] = []
    if (params.project) filterParts.push(`项目: ${params.project}`)
    if (statusFilter !== "all") filterParts.push(`状态: ${statusFilter}`)
    const filterLabel = filterParts.length ? `（过滤: ${filterParts.join(", ")}）` : ""

    const lines = ["=== 任务列表 ===", ""]
    lines.push(`共 ${totalCount} 个任务${filterLabel}`)
    if (statusSummary) lines.push(`状态统计: ${statusSummary}`)
    if (page.length > 0 && (offset > 0 || allJobs.length > limit)) {
      lines.push(`显示: ${offset + 1}-${offset + page.length}`)
    }
    lines.push("")

    for (let i = 0; i < page.length; i++) {
      const j = page[i]
      const label = STATUS_LABELS[j.status.family] ?? j.status.raw
      const typeTag = j.type === "hpc" ? " [HPC]" : ""
      lines.push(`${offset + i + 1}. [${label}] ${j.name}${typeTag}`)
      lines.push(
        `   ID: ${j.job_id}${j.gpu_count > 0 ? ` | GPU: ${j.gpu_count}卡` : ""}${j.priority ? ` | 优先级: ${j.priority}` : ""}`,
      )
      lines.push(`   空间: ${j.workspace_name} | 项目: ${j.project_name}`)

      const duration = InspireNormalize.formatDuration(j.running_time_ms)
      const created = InspireNormalize.formatTimestamp(j.created_at)
      if (j.status.family === "running" && duration) {
        lines.push(`   已运行: ${duration} | 创建于: ${created}`)
      } else if (created) {
        lines.push(`   创建于: ${created}`)
      }
      lines.push("")
    }

    if (allJobs.length > offset + limit) {
      lines.push(`...还有 ${allJobs.length - offset - limit} 个任务（使用 offset=${offset + limit} 查看下一页）`)
    }

    if (page.length === 0) {
      lines.push(filterParts.length > 0 ? `没有匹配的任务。` : "没有任务。")
    }

    return {
      title: `${page.length} 个任务`,
      output: lines.join("\n"),
      metadata: {
        total: totalCount,
        shown: page.length,
        status_counts: statusCounts,
        project: params.project,
        offset,
        limit,
      } as Record<string, any>,
    }
  },
})
