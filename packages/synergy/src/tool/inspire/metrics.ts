import z from "zod"
import { Tool } from "../tool"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { InspireNormalize } from "./normalize"

type MetricType = InspireAPI.MetricType
type MetricTimeSeries = InspireAPI.MetricTimeSeries

const DESCRIPTION = `Get training health metrics for a running or recently finished GPU job on the SII 启智平台.

Returns a structured health assessment — not raw time series — so you can directly decide whether a job is progressing normally, stuck, or wasting resources.

Use this to:
- Check if a running job is actually training (GPU utilization healthy?)
- Detect stuck/idle jobs (GPU near 0% for extended periods)
- Spot GPU memory pressure or potential OOM risk
- Decide whether to stop a wasteful job and resubmit with different config

Only works for GPU training jobs (job-xxx). Requires cookie-based auth.`

const TIME_RANGES = ["5m", "15m", "30m", "1h", "3h", "6h"] as const

type TimeRange = (typeof TIME_RANGES)[number]

function parseTimeRange(tr: TimeRange): number {
  const units: Record<string, number> = { m: 60, h: 3600 }
  const num = parseInt(tr.slice(0, -1), 10)
  const unit = tr.slice(-1)
  return num * (units[unit] ?? 60)
}

const parameters = z.object({
  job_id: z.string().describe("Task ID to check metrics for (job-xxx)"),
  time_range: z
    .enum(TIME_RANGES)
    .default("30m")
    .describe("Time window for metrics: 5m, 15m, 30m, 1h, 3h, 6h (default 30m)"),
})

interface MetricSummary {
  avg: number
  min: number
  max: number
  latest: number
  samples: number
}

function summarizeSeries(series: Array<{ data: number; timestamp: string }>): MetricSummary {
  if (series.length === 0) return { avg: 0, min: 0, max: 0, latest: 0, samples: 0 }
  const values = series.map((s) => s.data)
  const sum = values.reduce((a, b) => a + b, 0)
  return {
    avg: sum / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    latest: values[values.length - 1],
    samples: values.length,
  }
}

function assessHealth(
  gpu: MetricSummary | undefined,
  gpuMem: MetricSummary | undefined,
  cpu: MetricSummary | undefined,
  mem: MetricSummary | undefined,
): { status: string; details: string[] } {
  const details: string[] = []
  let status = "✅ 正常"

  if (!gpu || gpu.samples === 0) {
    return { status: "⚠️ 无数据", details: ["未获取到 GPU 利用率数据，任务可能刚启动或已结束很久"] }
  }

  // GPU utilization checks
  if (gpu.avg < 0.1) {
    status = "🔴 疑似卡住"
    details.push(`GPU 利用率平均仅 ${(gpu.avg * 100).toFixed(0)}%，任务可能卡住或未实际使用 GPU`)
  } else if (gpu.avg < 0.3) {
    status = "🟡 利用率偏低"
    details.push(`GPU 利用率平均 ${(gpu.avg * 100).toFixed(0)}%，可能存在 IO 瓶颈或数据加载慢`)
  } else if (gpu.avg >= 0.3 && gpu.avg < 0.7) {
    details.push(`GPU 利用率平均 ${(gpu.avg * 100).toFixed(0)}%，训练进行中但未充分利用`)
  } else {
    details.push(`GPU 利用率平均 ${(gpu.avg * 100).toFixed(0)}%，训练正常推进`)
  }

  // GPU memory checks
  if (gpuMem && gpuMem.samples > 0) {
    if (gpuMem.avg > 0.9) {
      status = "🔴 显存紧张"
      details.push(`GPU 显存平均占用 ${(gpuMem.avg * 100).toFixed(0)}%，有 OOM 风险`)
    } else if (gpuMem.avg > 0.8) {
      details.push(`GPU 显存平均占用 ${(gpuMem.avg * 100).toFixed(0)}%，偏高但暂时安全`)
    } else {
      details.push(`GPU 显存平均占用 ${(gpuMem.avg * 100).toFixed(0)}%`)
    }

    // Detect memory leak: check if latest > avg by significant margin
    if (gpuMem.latest > gpuMem.avg * 1.3 && gpuMem.samples >= 5) {
      details.push("显存使用呈上升趋势，可能存在内存泄漏")
    }
  }

  // CPU check
  if (cpu && cpu.samples > 0) {
    if (cpu.avg > 0.8) {
      details.push(`CPU 利用率 ${(cpu.avg * 100).toFixed(0)}%，偏高，可能成为瓶颈`)
    }
  }

  // Memory check
  if (mem && mem.samples > 0) {
    if (mem.avg > 0.9) {
      status = "🔴 内存紧张"
      details.push(`内存平均占用 ${(mem.avg * 100).toFixed(0)}%，有 OOM 风险`)
    }
  }

  return { status, details }
}

export const InspireMetricsTool = Tool.define("inspire_metrics", {
  description: DESCRIPTION,
  parameters,
  async execute(params) {
    const creds = await InspireAuth.getInspireCredentials()
    if (!creds) return InspireAuth.notAuthenticatedError("inspire")

    if (!params.job_id.startsWith("job-")) {
      return {
        title: "不支持",
        output: "inspire_metrics 仅支持 GPU 训练任务 (job-xxx)。",
        metadata: { error: "unsupported_type" } as Record<string, any>,
      }
    }

    // Get job detail for compute_group_id, task_id, running status
    let job: any
    try {
      const cookie = await InspireAuth.requireCookie()
      job = await InspireAuth.withCookieRetry((c) => InspireAPI.getJobDetail(c, params.job_id))
    } catch {
      return {
        title: "查询失败",
        output: `无法获取任务 ${params.job_id} 的详情，无法查询指标。`,
        metadata: { error: "job_not_found" } as Record<string, any>,
      }
    }

    const statusInfo = InspireNormalize.status(job.status ?? "")
    if (statusInfo.family !== "running" && statusInfo.family !== "succeeded" && statusInfo.family !== "failed") {
      return {
        title: `${params.job_id} 指标`,
        output: `任务状态为 ${statusInfo.family}，暂无指标数据。指标仅对运行中或刚结束的任务可用。`,
        metadata: { job_id: params.job_id, status: statusInfo.family } as Record<string, any>,
      }
    }

    const computeGroupId = job.logic_compute_group_id
    if (!computeGroupId) {
      return {
        title: "查询失败",
        output: "无法获取计算组 ID，无法查询指标。",
        metadata: { error: "missing_compute_group" } as Record<string, any>,
      }
    }

    // Compute time range from job timeline
    const cookie = await InspireAuth.requireCookie()
    const rangeSec = parseTimeRange(params.time_range)
    const now = Date.now()
    let startTs: number
    let endTs: number

    if (statusInfo.family === "running") {
      endTs = Math.floor(now / 1000)
      startTs = endTs - rangeSec
    } else {
      // For finished jobs, use the end time from timeline
      const timeline = job.timeline ?? {}
      const finishedTs = parseInt(timeline.finished ?? "0", 10)
      const runTs = parseInt(timeline.run ?? "0", 10)
      if (finishedTs > 0) {
        endTs = Math.floor(finishedTs / 1000)
        startTs = Math.max(Math.floor(runTs / 1000), endTs - rangeSec)
      } else {
        endTs = Math.floor(now / 1000)
        startTs = endTs - rangeSec
      }
    }

    // Adjust interval for long time ranges
    const intervalSec = rangeSec > 3600 ? 300 : rangeSec > 1800 ? 120 : 60

    const metricTypes: MetricType[] = ["gpu_usage_rate", "gpu_memory_usage_rate", "cpu_usage_rate", "memory_usage_rate"]

    let groups: MetricTimeSeries[]
    try {
      groups = await InspireAPI.getClusterMetrics(cookie, {
        computeGroupId,
        taskId: params.job_id,
        metricTypes,
        startTimestamp: startTs,
        endTimestamp: endTs,
        intervalSecond: intervalSec,
      })
    } catch {
      return {
        title: `${params.job_id} 指标`,
        output: "指标查询失败，可能是任务已结束较久或暂无监控数据。",
        metadata: { job_id: params.job_id, status: statusInfo.family } as Record<string, any>,
      }
    }

    // Organize by metric type
    const byType = new Map<string, MetricTimeSeries>()
    for (const g of groups) {
      byType.set(g.metric_type, g)
    }

    const gpu = summarizeSeries(byType.get("gpu_usage_rate")?.time_series ?? [])
    const gpuMem = summarizeSeries(byType.get("gpu_memory_usage_rate")?.time_series ?? [])
    const cpu = summarizeSeries(byType.get("cpu_usage_rate")?.time_series ?? [])
    const mem = summarizeSeries(byType.get("memory_usage_rate")?.time_series ?? [])

    const assessment = assessHealth(gpu, gpuMem, cpu, mem)

    const timeLabel =
      params.time_range === "5m"
        ? "5 分钟"
        : params.time_range === "15m"
          ? "15 分钟"
          : params.time_range === "30m"
            ? "30 分钟"
            : params.time_range === "1h"
              ? "1 小时"
              : params.time_range === "3h"
                ? "3 小时"
                : "6 小时"

    const lines = [
      `📊 训练健康报告: ${job.name ?? params.job_id}`,
      `状态: ${statusInfo.family} | 时间窗口: ${timeLabel}`,
      "",
      assessment.status,
      ...assessment.details.map((d) => `- ${d}`),
      "",
      "指标详情:",
    ]

    if (gpu.samples > 0) {
      lines.push(
        `  GPU 利用率: 平均 ${(gpu.avg * 100).toFixed(0)}%, 最低 ${(gpu.min * 100).toFixed(0)}%, 最高 ${(gpu.max * 100).toFixed(0)}% (${gpu.samples} 采样点)`,
      )
    }
    if (gpuMem.samples > 0) {
      lines.push(
        `  GPU 显存: 平均 ${(gpuMem.avg * 100).toFixed(0)}%, 最低 ${(gpuMem.min * 100).toFixed(0)}%, 最高 ${(gpuMem.max * 100).toFixed(0)}%`,
      )
    }
    if (cpu.samples > 0) {
      lines.push(`  CPU 利用率: 平均 ${(cpu.avg * 100).toFixed(0)}%`)
    }
    if (mem.samples > 0) {
      lines.push(`  内存占用: 平均 ${(mem.avg * 100).toFixed(0)}%`)
    }

    if (gpu.samples === 0 && gpuMem.samples === 0) {
      lines.push("  暂无指标数据")
    }

    return {
      title: `${job.name ?? params.job_id} 健康报告`,
      output: lines.join("\n"),
      metadata: {
        job_id: params.job_id,
        status: statusInfo.family,
        time_range: params.time_range,
        gpu_avg: gpu.avg,
        gpu_mem_avg: gpuMem.avg,
        cpu_avg: cpu.avg,
        mem_avg: mem.avg,
        health_status: assessment.status,
      } as Record<string, any>,
    }
  },
})
