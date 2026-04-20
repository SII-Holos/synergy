import z from "zod"
import { Tool } from "../tool"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { InspireNormalize } from "./normalize"
import { InspireCache } from "./cache"

async function findJobViaCookie(jobId: string): Promise<any | undefined> {
  const projects = await InspireCache.getProjects()
  const wsIds = new Set<string>()
  for (const proj of projects) {
    for (const space of proj.space_list ?? []) wsIds.add(space.id)
  }
  for (const wsId of wsIds) {
    try {
      const { jobs } = await InspireAuth.withCookieRetry((cookie) =>
        InspireAPI.listJobsWithCookie(cookie, wsId, { pageSize: 100 }),
      )
      const match = jobs.find((j: any) => (j.job_id ?? j.id) === jobId)
      if (match) return match
    } catch {}
  }
  return undefined
}

const DESCRIPTION = `Get detailed information about a specific task on the SII 启智平台, including the full command, image configuration, resource spec, and runtime status.

Use this to:
- Inspect a failed task's configuration for debugging
- Copy a successful task's settings to resubmit
- Check the actual resource allocation of a running task

When a task has failed, diagnostic suggestions are included based on common failure patterns (wrong environment, missing data, offline network, etc.).`

const parameters = z.object({
  job_id: z.string().describe("Task ID to query"),
})

export const InspireJobDetailTool = Tool.define("inspire_job_detail", {
  description: DESCRIPTION,
  parameters,
  async execute(params) {
    const creds = await InspireAuth.getInspireCredentials()
    if (!creds) return InspireAuth.notAuthenticatedError("inspire")

    let job: any
    try {
      job = await InspireAuth.withCookieRetry((cookie) => InspireAPI.getJobDetail(cookie, params.job_id))
    } catch {
      try {
        const found = await findJobViaCookie(params.job_id)
        if (found) job = found
      } catch {}
    }

    if (!job) {
      return {
        title: "查询失败",
        output: `无法获取任务 ${params.job_id} 的详情。Token 认证不可用且无法从任务列表中找到该任务。`,
        metadata: { error: "job_not_found", job_id: params.job_id } as Record<string, any>,
      }
    }

    const statusInfo = InspireNormalize.status(job.status ?? "")
    const gpuInfo = InspireAPI.extractGpuInfo(job)
    const duration = InspireNormalize.formatDuration(job.running_time_ms)
    const createdAt = InspireNormalize.formatTimestamp(job.created_at)
    const url = InspireAPI.buildJobUrl(job.job_id ?? params.job_id, job.workspace_id)

    const fc = job.framework_config ?? []
    const first = fc[0] ?? {}
    const spec = first.instance_spec_price_info ?? {}

    const lines = [
      `=== 任务详情: ${job.name} ===`,
      "",
      "基本信息:",
      `  任务 ID: ${job.job_id ?? params.job_id}`,
      `  状态: ${statusInfo.family} (${statusInfo.raw})`,
      `  创建于: ${createdAt}`,
      `  运行时长: ${duration || "—"}`,
      "",
      "配置:",
      `  命令: ${job.command ?? "—"}`,
      `  镜像: ${gpuInfo.image || "—"}`,
      `  规格: ${gpuInfo.gpu_count}× ${spec.gpu_type ?? "unknown"}, ${spec.cpu_count ?? "?"} CPU, ${spec.memory_gb ?? "?"} GB 内存`,
      `  节点数: ${gpuInfo.instance_count}`,
      `  优先级: ${job.priority_name ?? job.priority ?? "—"}`,
      "",
      "归属:",
      `  空间: ${job.workspace_name ?? "—"} (${job.workspace_id ?? "—"})`,
      `  项目: ${job.project_name ?? "—"} (${job.project_id ?? "—"})`,
      `  计算组: ${job.logic_compute_group_name ?? "—"} (${job.logic_compute_group_id ?? "—"})`,
      "",
      `任务页面: ${url}`,
    ]

    if (statusInfo.family === "failed") {
      lines.push("", "⚠ 诊断建议:")

      const runMs = parseInt(job.running_time_ms ?? "0", 10)
      if (runMs > 0 && runMs < 30_000) {
        lines.push(
          "  - 运行仅 " + Math.round(runMs / 1000) + " 秒后失败 → 可能是命令错误、镜像依赖缺失、conda 未初始化",
        )
      }

      const command = job.command ?? ""
      if (
        command.includes("pip install") ||
        command.includes("git clone") ||
        command.includes("wget") ||
        command.includes("curl")
      ) {
        lines.push("  - 命令中包含联网操作 → 如果是离线空间，请提前将依赖打包到镜像中")
      }

      if (!command.includes(">") && !command.includes("tee")) {
        lines.push(
          `  - 建议将输出重定向到文件: command > /inspire/hdd/project/${job.project_name ?? "proj"}/logs/output.log 2>&1`,
        )
      }

      lines.push("  - 常见原因: 环境变量缺失、数据路径不存在、GPU 驱动不兼容")
    }

    return {
      title: `${job.name} (${statusInfo.family})`,
      output: lines.join("\n"),
      metadata: {
        job_id: job.job_id ?? params.job_id,
        status: statusInfo.family,
        is_terminal: statusInfo.is_terminal,
        gpu_count: gpuInfo.gpu_count,
        instance_count: gpuInfo.instance_count,
      } as Record<string, any>,
    }
  },
})
