import z from "zod"
import { Tool } from "../tool"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"

const DESCRIPTION = `Query or download training job logs from the SII 启智平台.

Supports two modes:
- **Query** (default): Fetch recent logs for a job, optionally filtered by keyword or time range
- **Download**: Save full logs to a local file for deeper analysis with grep, ast_grep, or other tools

Use this to:
- Inspect error messages from a failed job
- Search for specific patterns in job output (e.g., "Error", "NaN", "OOM")
- Download logs for offline analysis when the output is too large to read inline
- Check training progress of a running job

The job must have run at least partially for logs to be available.`

const parameters = z.object({
  job_id: z.string().describe("Task ID to query logs for (job-xxx)"),
  keyword: z.string().optional().describe("Filter logs to lines containing this keyword (case-insensitive)"),
  lines: z.number().min(1).max(500).default(100).describe("Maximum number of log lines to return (1-500, default 100)"),
  start_time: z.string().optional().describe("Start time for log query (ISO 8601, e.g. '2026-04-19T15:00:00Z')"),
  end_time: z.string().optional().describe("End time for log query (ISO 8601, e.g. '2026-04-19T16:00:00Z')"),
  download: z
    .boolean()
    .default(false)
    .describe(
      "Download full logs to a local file instead of returning inline. Use for large logs that need grep/analysis.",
    ),
  download_path: z.string().optional().describe("Local file path for download mode (default: /tmp/{job_id}-logs.txt)"),
})

export const InspireLogsTool = Tool.define("inspire_logs", {
  description: DESCRIPTION,
  parameters,
  async execute(params) {
    const creds = await InspireAuth.getInspireCredentials()
    if (!creds) return InspireAuth.notAuthenticatedError("inspire")

    if (params.job_id.startsWith("sv-") || params.job_id.startsWith("hpc-job-")) {
      return {
        title: "不支持",
        output: "inspire_logs 目前仅支持 GPU 训练任务 (job-xxx) 的日志查询。",
        metadata: { error: "unsupported_type", job_id: params.job_id } as Record<string, any>,
      }
    }

    const cookie = await InspireAuth.requireCookie()

    // Resolve instance count from job detail
    const instanceCount = await resolveInstanceCount(cookie, params.job_id)

    if (params.download) {
      return handleDownload(cookie, params, instanceCount)
    }
    return handleQuery(cookie, params, instanceCount)
  },
})

async function resolveInstanceCount(cookie: string, jobId: string): Promise<number> {
  try {
    const job = await InspireAuth.withCookieRetry((c) => InspireAPI.getJobDetail(c, jobId))
    const gpuInfo = InspireAPI.extractGpuInfo(job)
    return gpuInfo.instance_count
  } catch {
    return 1
  }
}

async function handleQuery(cookie: string, params: z.infer<typeof parameters>, instanceCount: number) {
  const startMs = params.start_time ? String(new Date(params.start_time).getTime()) : undefined
  const endMs = params.end_time ? String(new Date(params.end_time).getTime()) : undefined

  // Fetch more lines than needed if keyword filtering will reduce results
  const fetchSize = params.keyword ? Math.min(params.lines * 3, 500) : params.lines

  const { logs, total } = await InspireAPI.getTrainLogs(cookie, {
    jobId: params.job_id,
    instanceCount,
    pageSize: fetchSize,
    startTimestampMs: startMs,
    endTimestampMs: endMs,
  })

  let filtered = logs
  if (params.keyword) {
    const kw = params.keyword.toLowerCase()
    filtered = logs.filter((l) => l.message.toLowerCase().includes(kw))
  }

  const displayLogs = filtered.slice(0, params.lines)

  if (displayLogs.length === 0) {
    const hint = params.keyword ? `未找到包含 "${params.keyword}" 的日志` : "暂无日志记录"
    return {
      title: `${params.job_id} 日志`,
      output: `📋 ${hint} (共 ${total} 条日志)`,
      metadata: {
        job_id: params.job_id,
        total,
        filtered: filtered.length,
        keyword: params.keyword,
      } as Record<string, any>,
    }
  }

  // Format: newest first (API returns descend order)
  const lines = displayLogs.map((log) => {
    const time = log.timestamp_str ?? log.time
    const pod = instanceCount > 1 ? ` [${log.pod_name.split("-").pop()}]` : ""
    return `[${time}]${pod} ${log.message}`
  })

  const kwInfo = params.keyword ? ` (筛选: "${params.keyword}")` : ""
  const output = [
    `📋 ${params.job_id} 日志${kwInfo}`,
    `共 ${total} 条，当前显示 ${displayLogs.length} 条`,
    "",
    ...lines,
  ].join("\n")

  return {
    title: `${params.job_id} 日志`,
    output,
    metadata: {
      job_id: params.job_id,
      total,
      filtered: filtered.length,
      displayed: displayLogs.length,
      keyword: params.keyword,
    } as Record<string, any>,
  }
}

async function handleDownload(cookie: string, params: z.infer<typeof parameters>, instanceCount: number) {
  const filePath = params.download_path || `/tmp/${params.job_id}-logs.txt`

  // Fetch all available logs in batches
  const allLogs: InspireAPI.TrainLogEntry[] = []
  const pageSize = 200
  let fetched = 0
  let total = Infinity

  while (fetched < total) {
    const { logs, total: t } = await InspireAPI.getTrainLogs(cookie, {
      jobId: params.job_id,
      instanceCount,
      pageSize,
    })
    total = t
    allLogs.push(...logs)
    fetched += logs.length
    if (logs.length < pageSize) break
  }

  // Reverse to chronological order for the file
  allLogs.reverse()

  const content = allLogs
    .map((log) => {
      const time = log.timestamp_str ?? log.time
      const pod = instanceCount > 1 ? ` [${log.pod_name.split("-").pop()}]` : ""
      return `[${time}]${pod} ${log.message}`
    })
    .join("\n")

  await Bun.write(filePath, content)

  return {
    title: `${params.job_id} 日志已下载`,
    output: [
      `✅ 日志已下载到: ${filePath}`,
      `共 ${allLogs.length} 条日志 (${(Buffer.byteLength(content) / 1024).toFixed(1)} KB)`,
      "",
      "可以使用以下方式分析:",
      `  grep "Error" ${filePath}`,
      `  grep -i "nan\\|oom\\|killed" ${filePath}`,
    ].join("\n"),
    metadata: {
      job_id: params.job_id,
      total: allLogs.length,
      file_path: filePath,
      file_size_kb: Math.round(Buffer.byteLength(content) / 1024),
    } as Record<string, any>,
  }
}
