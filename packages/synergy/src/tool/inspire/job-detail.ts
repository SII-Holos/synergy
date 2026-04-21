import z from "zod"
import { Tool } from "../tool"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { InspireNormalize } from "./normalize"
import { InspireCache } from "./cache"
import { classifyJobId } from "./shared"

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

Supports three task types by ID prefix:
- GPU training jobs (job-xxx)
- HPC jobs (hpc-job-xxx)
- Inference servings (sv-xxx)

Use this to:
- Inspect a failed task's configuration for debugging
- Copy a successful task's settings to resubmit
- Check the actual resource allocation of a running task
- Obtain the quota_id/spec_id needed for inspire_submit

When a task has failed, diagnostic suggestions are included based on common failure patterns (wrong environment, missing data, offline network, etc.).`

const parameters = z.object({
  job_id: z.string().describe("Task ID to query (job-xxx, hpc-job-xxx, or sv-xxx)"),
})

export const InspireJobDetailTool = Tool.define("inspire_job_detail", {
  description: DESCRIPTION,
  parameters,
  async execute(params) {
    const creds = await InspireAuth.getInspireCredentials()
    if (!creds) return InspireAuth.notAuthenticatedError("inspire")

    const type = classifyJobId(params.job_id)

    if (type === "inference") return handleInferenceDetail(params.job_id)
    if (type === "hpc") return handleHpcDetail(params.job_id)
    return handleGpuDetail(params.job_id)
  },
})

async function handleGpuDetail(jobId: string) {
  let job: any
  let usedOpenAPI = false

  try {
    const token = await InspireAuth.ensureToken()
    job = await InspireAuth.withTokenRetry((t) => InspireAPI.getJobDetailOpenAPI(t, jobId))
    usedOpenAPI = true
  } catch {
    try {
      job = await InspireAuth.withCookieRetry((cookie) => InspireAPI.getJobDetail(cookie, jobId))
    } catch {
      try {
        const found = await findJobViaCookie(jobId)
        if (found) job = found
      } catch {}
    }
  }

  if (!job) {
    return {
      title: "查询失败",
      output: `无法获取任务 ${jobId} 的详情。请确认任务 ID 正确且账号有权限查看。`,
      metadata: { error: "job_not_found", job_id: jobId } as Record<string, any>,
    }
  }

  const statusInfo = InspireNormalize.status(job.status ?? "")
  const gpuInfo = InspireAPI.extractGpuInfo(job)
  const duration = InspireNormalize.formatDuration(job.running_time_ms)
  const createdAt = InspireNormalize.formatTimestamp(job.created_at)
  const url = InspireAPI.buildJobUrl(job.job_id ?? jobId, job.workspace_id)

  const fc = job.framework_config ?? []
  const first = fc[0] ?? {}
  const spec = first.instance_spec_price_info ?? {}
  const specId = spec.quota_id ?? InspireAPI.extractSpecId(job)

  if (specId && job.workspace_id && job.logic_compute_group_id) {
    InspireCache.setCachedSpecId(job.workspace_id, job.logic_compute_group_id, specId, {
      gpuCount: gpuInfo.gpu_count,
    })
  }

  const timeline = InspireNormalize.analyzeTimeline(job.timeline)
  const lines = [
    `=== 任务详情: ${job.name} ===`,
    "",
    "基本信息:",
    `  任务 ID: ${job.job_id ?? jobId}`,
    `  类型: GPU 训练`,
    `  状态: ${statusInfo.family} (${statusInfo.raw})`,
    `  创建于: ${createdAt}`,
    `  运行时长: ${duration || "—"}`,
  ]

  if (timeline.summary) lines.push(`  时间线: ${timeline.summary}`)
  if (timeline.stages.length > 0) {
    for (const s of timeline.stages) lines.push(`    ${s.label}: ${s.value}`)
  }

  lines.push(
    "",
    "配置:",
    `  命令: ${job.command ?? "—"}`,
    `  镜像: ${gpuInfo.image || "—"}`,
    `  规格: ${gpuInfo.gpu_count}× ${spec.gpu_type ?? "unknown"}, ${spec.cpu_count ?? "?"} CPU, ${spec.memory_gb ?? "?"} GB 内存`,
    `  节点数: ${gpuInfo.instance_count}`,
    `  优先级: ${job.priority_name ?? job.priority ?? "—"}`,
  )

  if (specId) lines.push(`  规格 ID (quota_id): ${specId}`)
  if (spec.total_price_per_hour) lines.push(`  每小时价格: ${spec.total_price_per_hour}`)

  lines.push(
    "",
    "归属:",
    `  空间: ${job.workspace_name ?? "—"} (${job.workspace_id ?? "—"})`,
    `  项目: ${job.project_name ?? "—"} (${job.project_id ?? "—"})`,
    `  计算组: ${job.logic_compute_group_name ?? "—"} (${job.logic_compute_group_id ?? "—"})`,
    "",
    `任务页面: ${url}`,
  )

  if (usedOpenAPI) lines.push("查询方式: OpenAPI")

  if (statusInfo.family === "failed") {
    lines.push("", "⚠ 诊断建议:")

    const runMs = parseInt(job.running_time_ms ?? "0", 10)
    const command = job.command ?? ""
    const isMultiGpu = gpuInfo.gpu_count > 1 || gpuInfo.instance_count > 1

    if (timeline.neverStarted) {
      lines.push("  - 任务从未进入运行阶段 → 可能是镜像拉取失败、资源调度异常、或 spec_id 不正确")
    } else if (timeline.runMs !== undefined && timeline.runMs > 0 && timeline.runMs < 30_000) {
      lines.push(
        "  - 运行仅 " + Math.round(timeline.runMs / 1000) + " 秒后失败 → 可能是命令错误、镜像依赖缺失、conda 未初始化",
      )
    } else if (runMs > 0 && runMs < 30_000) {
      lines.push("  - 运行仅 " + Math.round(runMs / 1000) + " 秒后失败 → 可能是命令错误、镜像依赖缺失、conda 未初始化")
    }

    if (timeline.queueMs !== undefined && timeline.queueMs > 3_600_000) {
      lines.push(
        "  - 排队等待 " + Math.round(timeline.queueMs / 60_000) + " 分钟 → 长时间排队可能导致环境过期或资源状态变化",
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

    if (timeline.neverStarted && timeline.queueMs !== undefined && timeline.queueMs > 1_800_000) {
      lines.push("  - 停留在创建中超过 30 分钟 → 可能是镜像拉取失败或节点故障，建议联系运维")
    }

    if (parseInt(job.priority ?? "4", 10) <= 3) {
      lines.push("  - 低优先级任务 (1-3) 可能被高优先级任务抢占终止")
    }

    const budget = job.remain_budget ?? job.project_remain_budget
    if (budget !== undefined && budget <= 0) {
      lines.push("  - 项目点券已耗尽，可能导致任务中断（低优先级 CPU 任务不受点券限制）")
    }
  }

  if (statusInfo.family === "waiting") {
    lines.push("", "ℹ 排队说明:")
    lines.push("  - 任务已提交，等待 GPU 资源分配")

    if (timeline.queueMs !== undefined && timeline.queueMs > 0) {
      lines.push(`  - 已排队 ${Math.round(timeline.queueMs / 60_000)} 分钟`)
    }

    lines.push("  - 如果空闲 GPU 充足但仍排不上，可能原因:")
    lines.push("    • 节点存在污点(Taint): ECC 错误、网卡异常、GPU 故障")
    lines.push("    • 多机任务需要多个节点同时空闲")
    lines.push("    • 同优先级下用卡更少的任务优先调度")
    lines.push("  - 排队超过 24 小时建议: 切换到其他计算组，或联系运维排查")
    lines.push("  - 可调用 inspire_status 查看目标计算组当前空闲 GPU 数量")
  }

  if (statusInfo.family === "running") {
    lines.push("", "ℹ 运行提示:")
    lines.push("  - GPU 利用率长期过低的实例可能被自动回收，不同分区策略不同")
    lines.push("  - 使用 inspire_metrics 检查资源利用率是否正常")
  }

  // Fetch recent logs for failed or running jobs
  if (statusInfo.family === "failed" || statusInfo.family === "running") {
    try {
      const cookie = await InspireAuth.requireCookie()
      const { logs, total } = await InspireAPI.getTrainLogs(cookie, {
        jobId: job.job_id ?? jobId,
        instanceCount: gpuInfo.instance_count,
        pageSize: 50,
      })

      if (logs.length > 0) {
        lines.push("", `📋 最近日志 (共 ${total} 条，显示最新 ${logs.length} 条):`)
        // Logs come in descend order; show them newest-first
        const displayLogs = logs.slice(0, 30)
        for (const log of displayLogs) {
          const time = log.timestamp_str ?? log.time
          const msg = log.message
          lines.push(`  [${time}] ${msg}`)
        }
        if (total > 30) {
          lines.push(`  ... 还有 ${total - 30} 条日志`)
        }
        lines.push("  💡 使用 inspire_logs 可搜索/筛选日志，或下载到本地用 grep 检索")
      } else if (total === 0) {
        lines.push("", "📋 日志: 暂无日志记录")
      }
    } catch {
      // Log fetching is best-effort; don't fail the whole detail query
    }
  }

  return {
    title: `${job.name} (${statusInfo.family})`,
    output: lines.join("\n"),
    metadata: {
      job_id: job.job_id ?? jobId,
      type: "gpu",
      status: statusInfo.family,
      is_terminal: statusInfo.is_terminal,
      gpu_count: gpuInfo.gpu_count,
      instance_count: gpuInfo.instance_count,
      spec_id: specId,
      image: gpuInfo.image || undefined,
      command: job.command ?? undefined,
      project_id: job.project_id ?? undefined,
      project_name: job.project_name ?? undefined,
      project_en_name: job.project_en_name ?? undefined,
      workspace_id: job.workspace_id ?? undefined,
      workspace_name: job.workspace_name ?? undefined,
      compute_group_id: job.logic_compute_group_id ?? undefined,
      compute_group_name: job.logic_compute_group_name ?? undefined,
      priority: job.priority ?? job.priority_name ?? undefined,
    } as Record<string, any>,
  }
}

async function handleHpcDetail(jobId: string) {
  let job: any
  let usedOpenAPI = false

  try {
    const token = await InspireAuth.ensureToken()
    job = await InspireAuth.withTokenRetry((t) => InspireAPI.getHpcJobDetailOpenAPI(t, jobId))
    usedOpenAPI = true
  } catch {
    // No cookie fallback for HPC detail via cookie API — the internal API shape differs
    return {
      title: "查询失败",
      output: `无法获取 HPC 任务 ${jobId} 的详情。请确认任务 ID 正确且 OpenAPI 权限已开通。`,
      metadata: { error: "hpc_detail_failed", job_id: jobId } as Record<string, any>,
    }
  }

  const statusInfo = InspireNormalize.status(job.status ?? "")
  const createdAt = InspireNormalize.formatTimestamp(job.created_at)
  const duration = InspireNormalize.formatDuration(job.running_time_ms)
  const url = InspireAPI.buildJobUrl(jobId, job.workspace_id, "hpc")

  const lines = [
    `=== HPC 任务详情: ${job.name} ===`,
    "",
    "基本信息:",
    `  任务 ID: ${jobId}`,
    `  类型: HPC (Slurm)`,
    `  状态: ${statusInfo.family} (${statusInfo.raw})`,
    `  创建于: ${createdAt}`,
    `  运行时长: ${duration || "—"}`,
    "",
    "配置:",
    `  启动命令: ${job.entrypoint ?? job.command ?? "—"}`,
    `  镜像: ${job.image ?? "—"}`,
    `  CPU/任务: ${job.cpus_per_task ?? "?"} 核`,
    `  内存/CPU: ${job.memory_per_cpu ?? "?"}`,
    `  子任务数: ${job.number_of_tasks ?? "?"}`,
    `  节点数: ${job.instance_count ?? "?"}`,
    `  优先级: ${job.task_priority ?? job.priority_name ?? "—"}`,
  ]

  if (job.spec_id ?? job.quota_id) lines.push(`  规格 ID: ${job.spec_id ?? job.quota_id}`)
  if (job.ttl_after_finish_seconds) lines.push(`  结束保留: ${job.ttl_after_finish_seconds}s`)

  lines.push(
    "",
    "归属:",
    `  空间: ${job.workspace_name ?? "—"} (${job.workspace_id ?? "—"})`,
    `  项目: ${job.project_name ?? "—"} (${job.project_id ?? "—"})`,
    "",
    `任务页面: ${url}`,
  )

  if (usedOpenAPI) lines.push("查询方式: OpenAPI")

  return {
    title: `${job.name} (${statusInfo.family})`,
    output: lines.join("\n"),
    metadata: {
      job_id: jobId,
      type: "hpc",
      status: statusInfo.family,
      is_terminal: statusInfo.is_terminal,
    } as Record<string, any>,
  }
}

async function handleInferenceDetail(servingId: string) {
  let serving: any

  try {
    const token = await InspireAuth.ensureToken()
    serving = await InspireAuth.withTokenRetry((t) => InspireAPI.getInferenceDetailOpenAPI(t, servingId))
  } catch (err: any) {
    return {
      title: "查询失败",
      output: `无法获取推理服务 ${servingId} 的详情: ${err.message ?? err}`,
      metadata: { error: "inference_detail_failed", serving_id: servingId } as Record<string, any>,
    }
  }

  const statusInfo = InspireNormalize.status(serving.status ?? "")
  const createdAt = InspireNormalize.formatTimestamp(serving.created_at)
  const url = InspireAPI.buildJobUrl(servingId, serving.workspace_id, "inference")

  const lines = [
    `=== 推理服务详情: ${serving.name} ===`,
    "",
    "基本信息:",
    `  服务 ID: ${servingId}`,
    `  类型: 推理服务`,
    `  状态: ${statusInfo.family} (${statusInfo.raw})`,
    `  创建于: ${createdAt}`,
    "",
    "配置:",
    `  命令: ${serving.command ?? "—"}`,
    `  镜像: ${serving.image ?? "—"}`,
    `  模型: ${serving.model_id ?? "—"} (v${serving.model_version ?? "?"})`,
    `  端口: ${serving.port ?? "—"}`,
    `  副本数: ${serving.replicas ?? "—"}`,
    `  每副本节点: ${serving.node_num_per_replica ?? "—"}`,
    `  优先级: ${serving.task_priority ?? serving.priority_name ?? "—"}`,
  ]

  if (serving.spec_id ?? serving.quota_id) lines.push(`  规格 ID: ${serving.spec_id ?? serving.quota_id}`)
  if (serving.custom_domain) lines.push(`  自定义域名: ${serving.custom_domain}`)

  lines.push(
    "",
    "归属:",
    `  空间: ${serving.workspace_name ?? "—"} (${serving.workspace_id ?? "—"})`,
    `  项目: ${serving.project_name ?? "—"} (${serving.project_id ?? "—"})`,
    `  计算组: ${serving.logic_compute_group_name ?? "—"}`,
    "",
    `服务页面: ${url}`,
  )

  if (serving.access_url) lines.push(`访问地址: ${serving.access_url}`)

  return {
    title: `${serving.name} (${statusInfo.family})`,
    output: lines.join("\n"),
    metadata: {
      serving_id: servingId,
      type: "inference",
      status: statusInfo.family,
      is_terminal: statusInfo.is_terminal,
    } as Record<string, any>,
  }
}
