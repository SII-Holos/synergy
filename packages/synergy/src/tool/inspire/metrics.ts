import z from "zod"
import { Tool } from "../tool"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { InspireNormalize } from "./normalize"

type MetricType = InspireAPI.MetricType
type MetricTimeSeries = InspireAPI.MetricTimeSeries

const DESCRIPTION = `Get training resource metrics for a GPU job on the SII 启智平台.

Supports three modes:
- **summary** (default): Rich statistical summary with health assessment — avg, p50, p90, min, max, trend, idle windows, stability. Lets you decide if a job is healthy, stuck, or wasting resources.
- **raw**: Return the raw time-series data points directly for custom analysis.
- **download**: Save raw metrics to a local JSON file for deeper offline analysis with grep, jq, or scripts.

Use this to:
- Check if a running job is actually training (GPU utilization healthy?)
- Detect stuck/idle jobs (GPU near 0% for extended periods — note: idle instances may be auto-reclaimed by the platform)
- Spot GPU memory pressure or potential OOM risk
- Analyze utilization trends and idle windows
- Download metrics data for custom analysis when summary isn't enough

Note: Monitoring data has ~15s reporting delay. A 0% reading may not reflect the current state.
Only works for GPU training jobs (job-xxx).`

const TIME_RANGES = ["5m", "15m", "30m", "1h", "3h", "6h"] as const
type TimeRange = (typeof TIME_RANGES)[number]

function parseTimeRange(tr: TimeRange): number {
  const units: Record<string, number> = { m: 60, h: 3600 }
  const num = parseInt(tr.slice(0, -1), 10)
  const unit = tr.slice(-1)
  return num * (units[unit] ?? 60)
}

function autoIntervalSec(rangeSec: number): number {
  if (rangeSec >= 10800) return 300
  if (rangeSec >= 3600) return 120
  if (rangeSec >= 1800) return 60
  return 30
}

const parameters = z.object({
  job_id: z.string().describe("Task ID to check metrics for (job-xxx)"),
  time_range: z
    .enum(TIME_RANGES)
    .default("30m")
    .describe("Time window for metrics: 5m, 15m, 30m, 1h, 3h, 6h (default 30m)"),
  interval: z
    .number()
    .optional()
    .describe("Sampling interval in seconds. Omit for auto-selection based on time_range."),
  mode: z
    .enum(["summary", "raw", "download"])
    .default("summary")
    .describe(
      "summary: statistical summary + health assessment (default). raw: return raw time-series data. download: save to local file.",
    ),
  download_path: z
    .string()
    .optional()
    .describe("Local file path for download mode (default: /tmp/{job_id}-metrics.json)"),
})

// --- Statistical helpers ---

type Trend = "up" | "down" | "stable"

interface IdleWindow {
  startIdx: number
  endIdx: number
  durationSamples: number
}

interface MetricSummary {
  avg: number
  p50: number
  p90: number
  min: number
  max: number
  latest: number
  stddev: number
  samples: number
  trend: Trend
  trendMagnitude: number
  idleWindows: IdleWindow[]
  idleTotalSamples: number
}

const IDLE_THRESHOLD = 0.05

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function detectIdleWindows(values: number[], threshold: number): IdleWindow[] {
  const windows: IdleWindow[] = []
  let start = -1
  for (let i = 0; i < values.length; i++) {
    if (values[i] < threshold) {
      if (start === -1) start = i
    } else {
      if (start !== -1) {
        windows.push({ startIdx: start, endIdx: i - 1, durationSamples: i - start })
        start = -1
      }
    }
  }
  if (start !== -1) {
    windows.push({ startIdx: start, endIdx: values.length - 1, durationSamples: values.length - start })
  }
  return windows
}

function computeTrend(values: number[]): { trend: Trend; magnitude: number } {
  if (values.length < 4) return { trend: "stable", magnitude: 0 }
  const mid = Math.floor(values.length / 2)
  const firstHalf = values.slice(0, mid)
  const secondHalf = values.slice(mid)
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length
  const magnitude = avgSecond - avgFirst
  if (Math.abs(magnitude) < 0.05) return { trend: "stable", magnitude }
  return { trend: magnitude > 0 ? "up" : "down", magnitude }
}

function summarizeSeries(series: Array<{ data: number; timestamp: string }>): MetricSummary {
  if (series.length === 0) {
    return {
      avg: 0,
      p50: 0,
      p90: 0,
      min: 0,
      max: 0,
      latest: 0,
      stddev: 0,
      samples: 0,
      trend: "stable",
      trendMagnitude: 0,
      idleWindows: [],
      idleTotalSamples: 0,
    }
  }

  const values = series.map((s) => s.data)
  const sorted = [...values].sort((a, b) => a - b)
  const sum = values.reduce((a, b) => a + b, 0)
  const avg = sum / values.length
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / values.length
  const stddev = Math.sqrt(variance)
  const { trend, magnitude: trendMagnitude } = computeTrend(values)
  const idleWindows = detectIdleWindows(values, IDLE_THRESHOLD)
  const idleTotalSamples = idleWindows.reduce((acc, w) => acc + w.durationSamples, 0)

  return {
    avg,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    latest: values[values.length - 1],
    stddev,
    samples: values.length,
    trend,
    trendMagnitude,
    idleWindows,
    idleTotalSamples,
  }
}

// --- Health assessment ---

function assessHealth(
  gpu: MetricSummary,
  gpuMem: MetricSummary,
  cpu: MetricSummary,
  mem: MetricSummary,
  jobStatus: string,
  availableTypes: string[],
): { status: string; details: string[] } {
  const details: string[] = []
  let status = "✅ 正常"
  const isFinished = jobStatus === "succeeded" || jobStatus === "failed"
  const isRunning = jobStatus === "running"
  const requestedTypes = ["gpu_usage_rate", "gpu_memory_usage_rate", "cpu_usage_rate", "memory_usage_rate"]
  const missingTypes = requestedTypes.filter((t) => !availableTypes.includes(t))

  if (gpu.samples === 0) {
    return { status: "⚠️ 无数据", details: ["未获取到 GPU 利用率数据，任务可能刚启动或已结束很久"] }
  }

  // GPU utilization
  const cpuBottleneck = cpu.samples > 0 && cpu.avg > 0.7
  if (gpu.avg < 0.1) {
    if (jobStatus === "succeeded") {
      status = "🟡 GPU 利用率低"
      if (cpuBottleneck) {
        details.push(`GPU 利用率平均仅 ${(gpu.avg * 100).toFixed(0)}%，CPU 利用率 ${fmtPct(cpu.avg)}，CPU 是瓶颈`)
      } else {
        details.push(`GPU 利用率平均仅 ${(gpu.avg * 100).toFixed(0)}%，任务可能以 CPU 为主或未充分利用 GPU`)
      }
    } else if (isFinished) {
      status = "🔴 疑似卡住"
      details.push(`GPU 利用率平均仅 ${(gpu.avg * 100).toFixed(0)}%，任务失败且 GPU 未使用`)
    } else if (gpu.trend === "up" && gpu.p90 > 0.3) {
      status = "🟡 预热中"
      details.push(
        `GPU 利用率平均 ${(gpu.avg * 100).toFixed(0)}%，但呈上升趋势 (P90 ${fmtPct(gpu.p90)})，可能处于启动/数据加载阶段`,
      )
    } else if (cpuBottleneck) {
      status = "🟡 CPU 瓶颈"
      details.push(
        `GPU 利用率平均 ${(gpu.avg * 100).toFixed(0)}%，CPU 利用率 ${fmtPct(cpu.avg)}，CPU 是瓶颈导致 GPU 等待`,
      )
    } else {
      status = "🔴 疑似卡住"
      details.push(`GPU 利用率平均仅 ${(gpu.avg * 100).toFixed(0)}%，任务可能卡住或未实际使用 GPU`)
    }
  } else if (gpu.avg < 0.3) {
    if (jobStatus === "succeeded") {
      if (cpuBottleneck) {
        details.push(`GPU 利用率平均 ${(gpu.avg * 100).toFixed(0)}%，CPU 利用率 ${fmtPct(cpu.avg)}，CPU 是瓶颈`)
      } else {
        details.push(`GPU 利用率平均 ${(gpu.avg * 100).toFixed(0)}%，任务可能以 CPU 为主`)
      }
    } else if (isFinished) {
      status = "🟡 利用率偏低"
      details.push(`GPU 利用率平均 ${(gpu.avg * 100).toFixed(0)}%，任务失败且 GPU 利用不足`)
    } else if (cpuBottleneck) {
      status = "🟡 CPU 瓶颈"
      details.push(
        `GPU 利用率平均 ${(gpu.avg * 100).toFixed(0)}%，CPU 利用率 ${fmtPct(cpu.avg)}，CPU 是瓶颈导致 GPU 等待`,
      )
    } else {
      status = "🟡 利用率偏低"
      details.push(`GPU 利用率平均 ${(gpu.avg * 100).toFixed(0)}%，可能存在 IO 瓶颈或数据加载慢`)
    }
  } else if (gpu.avg < 0.7) {
    details.push(`GPU 利用率平均 ${(gpu.avg * 100).toFixed(0)}%，训练进行中但未充分利用`)
  } else {
    details.push(`GPU 利用率平均 ${(gpu.avg * 100).toFixed(0)}%，训练正常推进`)
  }

  // GPU trend
  if (gpu.trend === "down" && Math.abs(gpu.trendMagnitude) > 0.15) {
    if (isRunning) {
      details.push(`⚠ GPU 利用率呈下降趋势 (前半/后半差 ${(-gpu.trendMagnitude * 100).toFixed(0)}%)`)
    } else {
      details.push(`GPU 利用率呈下降趋势 (前半/后半差 ${(-gpu.trendMagnitude * 100).toFixed(0)}%)`)
    }
  } else if (gpu.trend === "up" && gpu.trendMagnitude > 0.15) {
    details.push(`GPU 利用率呈上升趋势 (+${(gpu.trendMagnitude * 100).toFixed(0)}%)`)
  }

  // GPU idle windows — only flag as problem if no upward trend (avoid false alarm on warmup)
  if (gpu.idleWindows.length > 0 && gpu.idleTotalSamples > 0 && gpu.trend !== "up") {
    const idleRatio = gpu.idleTotalSamples / gpu.samples
    if (idleRatio > 0.5 && isRunning) {
      details.push(`${gpu.idleWindows.length} 段空闲期，累计占比 ${(idleRatio * 100).toFixed(0)}%，GPU 长时间未工作`)
    } else if (idleRatio > 0.3) {
      details.push(`${gpu.idleWindows.length} 段空闲期，累计占比 ${(idleRatio * 100).toFixed(0)}%`)
    } else if (idleRatio > 0.1) {
      details.push(`${gpu.idleWindows.length} 段短暂空闲，累计占比 ${(idleRatio * 100).toFixed(0)}%`)
    }
  }

  // GPU stability
  if (gpu.stddev > 0.25 && gpu.avg > 0.3) {
    details.push("GPU 利用率波动较大，训练可能不稳定")
  }

  // GPU memory
  if (gpuMem.samples > 0) {
    if (gpuMem.p90 > 0.9) {
      status = "🔴 显存紧张"
      details.push(`GPU 显存 P90 ${(gpuMem.p90 * 100).toFixed(0)}%，有 OOM 风险`)
    } else if (gpuMem.avg > 0.8) {
      details.push(`GPU 显存平均 ${(gpuMem.avg * 100).toFixed(0)}%，偏高但暂时安全`)
    } else {
      details.push(`GPU 显存平均 ${(gpuMem.avg * 100).toFixed(0)}%`)
    }
    if (gpuMem.trend === "up" && gpuMem.trendMagnitude > 0.1 && gpuMem.samples >= 5) {
      details.push("显存使用呈上升趋势，可能存在内存泄漏")
    }
  }

  // CPU (only note if not already reported as bottleneck above)
  if (cpu.samples > 0 && cpu.avg > 0.7 && gpu.avg >= 0.3) {
    details.push(`CPU 利用率 ${fmtPct(cpu.avg)}，偏高，可能成为瓶颈`)
  }

  // Memory
  if (mem.samples > 0) {
    if (mem.avg > 0.9) {
      status = "🔴 内存紧张"
      details.push(`内存平均占用 ${(mem.avg * 100).toFixed(0)}%，有 OOM 风险`)
    }
  }

  // Missing metrics note
  if (missingTypes.length > 0 && missingTypes.length < requestedTypes.length) {
    const names = missingTypes.map((t) => t.replace(/_/g, " ").replace("rate", "").trim()).join("、")
    details.push(`平台未返回 ${names} 指标数据`)
  }

  return { status, details }
}

// --- Formatting helpers ---

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  "5m": "5 分钟",
  "15m": "15 分钟",
  "30m": "30 分钟",
  "1h": "1 小时",
  "3h": "3 小时",
  "6h": "6 小时",
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}

function fmtSummaryLine(name: string, s: MetricSummary): string {
  const parts = [`平均 ${fmtPct(s.avg)}`, `P50 ${fmtPct(s.p50)}`, `P90 ${fmtPct(s.p90)}`]
  parts.push(`最低 ${fmtPct(s.min)}`, `最高 ${fmtPct(s.max)}`)
  if (s.trend !== "stable") {
    const arrow = s.trend === "up" ? "↑" : "↓"
    parts.push(`趋势 ${arrow}`)
  }
  parts.push(`${s.samples} 采样点`)
  return `  ${name}: ${parts.join(", ")}`
}

// --- Fetch logic (shared across modes) ---

async function fetchMetrics(
  cookie: string,
  job: any,
  params: z.infer<typeof parameters>,
): Promise<{ groups: MetricTimeSeries[]; startTs: number; endTs: number; intervalSec: number } | null> {
  const computeGroupId = job.logic_compute_group_id
  if (!computeGroupId) return null

  const statusInfo = InspireNormalize.status(job.status ?? "")
  const rangeSec = parseTimeRange(params.time_range)
  const now = Date.now()
  let startTs: number
  let endTs: number

  if (statusInfo.family === "running") {
    endTs = Math.floor(now / 1000)
    startTs = endTs - rangeSec
  } else {
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

  const intervalSec = params.interval ?? autoIntervalSec(rangeSec)
  const metricTypes: MetricType[] = ["gpu_usage_rate", "gpu_memory_usage_rate", "cpu_usage_rate", "memory_usage_rate"]

  // Platform API only returns data for the first element in metric_types array.
  // Request each type individually and merge results.
  const allGroups: MetricTimeSeries[] = []
  const results = await Promise.allSettled(
    metricTypes.map((mt) =>
      InspireAPI.getClusterMetrics(cookie, {
        computeGroupId,
        taskId: params.job_id,
        metricTypes: [mt],
        startTimestamp: startTs,
        endTimestamp: endTs,
        intervalSecond: intervalSec,
      }),
    ),
  )
  for (const r of results) {
    if (r.status === "fulfilled") allGroups.push(...r.value)
  }

  return { groups: allGroups, startTs, endTs, intervalSec }
}

// --- Mode handlers ---

function handleSummary(job: any, params: z.infer<typeof parameters>, groups: MetricTimeSeries[], intervalSec: number) {
  const statusInfo = InspireNormalize.status(job.status ?? "")

  // Aggregate across all groups of the same metric type (multi-GPU)
  const seriesByType = new Map<string, Array<{ data: number; timestamp: string }>>()
  for (const g of groups) {
    const existing = seriesByType.get(g.metric_type) ?? []
    existing.push(...g.time_series)
    seriesByType.set(g.metric_type, existing)
  }

  const gpu = summarizeSeries(seriesByType.get("gpu_usage_rate") ?? [])
  const gpuMem = summarizeSeries(seriesByType.get("gpu_memory_usage_rate") ?? [])
  const cpu = summarizeSeries(seriesByType.get("cpu_usage_rate") ?? [])
  const mem = summarizeSeries(seriesByType.get("memory_usage_rate") ?? [])

  const availableTypes = [...seriesByType.keys()]
  const assessment = assessHealth(gpu, gpuMem, cpu, mem, statusInfo.family, availableTypes)

  const lines = [
    `📊 训练健康报告: ${job.name ?? params.job_id}`,
    `状态: ${statusInfo.family} | 时间窗口: ${TIME_RANGE_LABELS[params.time_range]} | 采样间隔: ${intervalSec}s`,
    "",
    assessment.status,
    ...assessment.details.map((d) => `- ${d}`),
    "",
    "指标详情:",
  ]

  if (gpu.samples > 0) lines.push(fmtSummaryLine("GPU 利用率", gpu))
  if (gpuMem.samples > 0) lines.push(fmtSummaryLine("GPU 显存", gpuMem))
  if (cpu.samples > 0) lines.push(fmtSummaryLine("CPU 利用率", cpu))
  if (mem.samples > 0) lines.push(fmtSummaryLine("内存占用", mem))
  if (gpu.samples === 0 && gpuMem.samples === 0) lines.push("  暂无指标数据")

  return {
    title: `${job.name ?? params.job_id} 健康报告`,
    output: lines.join("\n"),
    metadata: {
      job_id: params.job_id,
      status: statusInfo.family,
      time_range: params.time_range,
      interval_sec: intervalSec,
      health_status: assessment.status,
      gpu: {
        avg: gpu.avg,
        p50: gpu.p50,
        p90: gpu.p90,
        trend: gpu.trend,
        stddev: gpu.stddev,
        idle_windows: gpu.idleWindows.length,
      },
      gpu_mem: { avg: gpuMem.avg, p50: gpuMem.p50, p90: gpuMem.p90, trend: gpuMem.trend },
      cpu: { avg: cpu.avg },
      mem: { avg: mem.avg },
    } as Record<string, any>,
  }
}

function handleRaw(job: any, params: z.infer<typeof parameters>, groups: MetricTimeSeries[], intervalSec: number) {
  const statusInfo = InspireNormalize.status(job.status ?? "")
  const lines = [
    `📈 ${job.name ?? params.job_id} 原始指标数据`,
    `状态: ${statusInfo.family} | 时间窗口: ${TIME_RANGE_LABELS[params.time_range]} | 采样间隔: ${intervalSec}s`,
    `共 ${groups.length} 组时序数据`,
    "",
  ]

  for (const g of groups) {
    const ts = g.time_series
    lines.push(`--- ${g.metric_type} (${g.group_name} / ${g.resource_name}) ---`)
    lines.push(`采样点: ${ts.length}`)
    if (ts.length > 0) {
      const first = ts[0]
      const last = ts[ts.length - 1]
      lines.push(`时间范围: ${first.timestamp} ~ ${last.timestamp}`)
      lines.push("")
      for (const point of ts) {
        lines.push(`  ${point.timestamp}  ${(point.data * 100).toFixed(1)}%`)
      }
    }
    lines.push("")
  }

  return {
    title: `${job.name ?? params.job_id} 原始指标`,
    output: lines.join("\n"),
    metadata: {
      job_id: params.job_id,
      status: statusInfo.family,
      time_range: params.time_range,
      interval_sec: intervalSec,
      group_count: groups.length,
    } as Record<string, any>,
  }
}

async function handleDownload(
  job: any,
  params: z.infer<typeof parameters>,
  groups: MetricTimeSeries[],
  intervalSec: number,
  startTs: number,
  endTs: number,
) {
  const filePath = params.download_path || `/tmp/${params.job_id}-metrics.json`
  const statusInfo = InspireNormalize.status(job.status ?? "")

  const payload = {
    job_id: params.job_id,
    job_name: job.name ?? null,
    status: statusInfo.family,
    time_range: params.time_range,
    interval_sec: intervalSec,
    query_start_ts: startTs,
    query_end_ts: endTs,
    groups: groups.map((g) => ({
      metric_type: g.metric_type,
      group_name: g.group_name,
      resource_name: g.resource_name,
      time_series: g.time_series,
    })),
  }

  const content = JSON.stringify(payload, null, 2)
  await Bun.write(filePath, content)

  const sizeKb = (Buffer.byteLength(content) / 1024).toFixed(1)

  return {
    title: `${job.name ?? params.job_id} 指标已下载`,
    output: [
      `✅ 指标数据已下载到: ${filePath}`,
      `共 ${groups.length} 组时序，文件大小 ${sizeKb} KB`,
      "",
      "分析示例:",
      `  cat ${filePath} | jq '.groups[] | select(.metric_type=="gpu_usage_rate") | .time_series | length'`,
      `  cat ${filePath} | jq '.groups[] | .time_series[] | select(.data < 0.05)'`,
    ].join("\n"),
    metadata: {
      job_id: params.job_id,
      status: statusInfo.family,
      time_range: params.time_range,
      interval_sec: intervalSec,
      group_count: groups.length,
      file_path: filePath,
      file_size_kb: Math.round(Buffer.byteLength(content) / 1024),
    } as Record<string, any>,
  }
}

// --- Tool definition ---

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

    const cookie = await InspireAuth.requireCookie()
    const fetchResult = await fetchMetrics(cookie, job, params).catch(() => null)
    if (!fetchResult) {
      return {
        title: "查询失败",
        output: "无法获取计算组 ID，无法查询指标。",
        metadata: { error: "missing_compute_group" } as Record<string, any>,
      }
    }

    const { groups, startTs, endTs, intervalSec } = fetchResult

    if (groups.length === 0) {
      return {
        title: `${params.job_id} 指标`,
        output: "指标查询返回空数据，可能是任务已结束较久或暂无监控数据。",
        metadata: { job_id: params.job_id, status: statusInfo.family, time_range: params.time_range } as Record<
          string,
          any
        >,
      }
    }

    switch (params.mode) {
      case "raw":
        return handleRaw(job, params, groups, intervalSec)
      case "download":
        return handleDownload(job, params, groups, intervalSec, startTs, endTs)
      default:
        return handleSummary(job, params, groups, intervalSec)
    }
  },
})
