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
      const command = job.command ?? ""
      const isMultiGpu = gpuInfo.gpu_count > 1 || gpuInfo.instance_count > 1

      if (runMs > 0 && runMs < 30_000) {
        lines.push(
          "  - 运行仅 " + Math.round(runMs / 1000) + " 秒后失败 → 可能是命令错误、镜像依赖缺失、conda 未初始化",
        )
      }

      if (
        command.includes("pip install") ||
        command.includes("git clone") ||
        command.includes("wget") ||
        command.includes("curl")
      ) {
        lines.push("  - 命令中包含联网操作 → 如果是离线空间，请提前将依赖打包到镜像中")
      }

      if (isMultiGpu) {
        lines.push("  - 多卡/多机任务: 如果报 NCCL Error / Socket timeout，尝试在命令前添加:")
        lines.push("    export NCCL_P2P_DISABLE=1 NCCL_NVLS_ENABLE=0 NCCL_IB_RETRY_CNT=255 NCCL_IB_TIMEOUT=25")
        lines.push("  - 确认共享内存(shm)已设置且足够大（多卡训练建议 ≥64GB）")
      }

      if (!command.includes(">") && !command.includes("tee")) {
        lines.push(
          `  - 建议将输出重定向到文件以便诊断: 2>&1 | tee /inspire/hdd/project/${job.project_en_name ?? job.project_name ?? "proj"}/logs/${job.name ?? "output"}.log`,
        )
      }

      lines.push("  - 常见原因: 环境变量缺失、数据路径不存在、GPU 驱动不兼容、镜像中缺少依赖")
    }

    if (statusInfo.family === "waiting") {
      lines.push("", "ℹ 排队说明:")
      lines.push("  - 任务已提交，等待 GPU 资源分配")
      lines.push("  - 如果空闲 GPU 充足但仍排不上，可能原因:")
      lines.push("    • 节点存在污点(Taint): ECC 错误、网卡异常、GPU 故障")
      lines.push("    • 多机任务需要多个节点同时空闲")
      lines.push("    • 同优先级下用卡更少的任务优先调度")
      lines.push("  - 排队超过 24 小时建议: 切换到其他计算组，或联系运维排查")
      lines.push("  - 可调用 inspire_status 查看目标计算组当前空闲 GPU 数量")
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
