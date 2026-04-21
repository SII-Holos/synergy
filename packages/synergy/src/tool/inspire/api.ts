import { InspireTypes } from "./types"
import { InspireAuth } from "./auth"
import { InspireNormalize } from "./normalize"
import { Log } from "../../util/log"

export namespace InspireAPI {
  const log = Log.create({ service: "inspire.api" })

  function cookieHeaders(cookie: string, workspaceId?: string): Record<string, string> {
    return {
      ...InspireTypes.BROWSER_HEADERS,
      cookie,
      referer: workspaceId
        ? `${InspireTypes.PLATFORM_URL}/jobs/spacesOverview?spaceId=${workspaceId}`
        : `${InspireTypes.PLATFORM_URL}/`,
    }
  }

  async function postOpenAPI<T = any>(endpoint: string, body: Record<string, any>, token: string): Promise<T> {
    const resp = await fetch(`${InspireTypes.PLATFORM_URL}${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (resp.status === 401 || resp.status === 302 || resp.status === 403) {
      throw Object.assign(new Error("Token expired or invalid"), { code: -1, status: resp.status })
    }
    const text = await resp.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      throw Object.assign(new Error(`API returned non-JSON response (HTTP ${resp.status})`), { status: resp.status })
    }
    if (data.code === -1) throw Object.assign(new Error("Token expired"), { code: -1 })
    if (data.code !== 0) throw new Error(data.message ?? `API error code ${data.code}`)
    return data.data ?? data
  }

  async function postInternal<T = any>(
    endpoint: string,
    body: Record<string, any>,
    cookie: string,
    workspaceId?: string,
  ): Promise<T> {
    const resp = await fetch(`${InspireTypes.PLATFORM_URL}${endpoint}`, {
      method: "POST",
      headers: cookieHeaders(cookie, workspaceId),
      body: JSON.stringify(body),
    })
    if (resp.status === 401) throw Object.assign(new Error("Cookie expired"), { status: 401 })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = (await resp.json()) as any
    if (data.code !== 0) throw new Error(data.message ?? `API error code ${data.code}`)
    return data.data ?? data
  }

  export async function listProjects(cookie: string): Promise<any[]> {
    const data = await postInternal("/api/v1/project/list", { page: 1, page_size: 100, filter: {} }, cookie)
    return data.items ?? []
  }

  export async function getClusterBasicInfo(cookie: string, workspaceId: string): Promise<any> {
    return postInternal("/api/v1/cluster_metric/cluster_basic_info", { workspace_id: workspaceId }, cookie, workspaceId)
  }

  export async function listNodeDimension(
    cookie: string,
    workspaceId: string,
    computeGroupId?: string,
  ): Promise<any[]> {
    const filter: Record<string, any> = { workspace_id: workspaceId }
    if (computeGroupId) filter.logic_compute_group_id = computeGroupId
    const data = await postInternal(
      "/api/v1/cluster_metric/list_node_dimension",
      { page_num: 1, page_size: 500, filter },
      cookie,
      workspaceId,
    )
    return data.node_dimensions ?? []
  }

  export async function listSpecs(cookie: string, computeGroupId: string): Promise<any[]> {
    try {
      const data = await postInternal("/api/v1/specs/list", { logic_compute_group_id: computeGroupId }, cookie)
      return data.specs ?? []
    } catch {
      return []
    }
  }

  export type ImageType = "SOURCE_PUBLIC" | "SOURCE_PRIVATE" | "SOURCE_OFFICIAL"

  export async function createJobOpenAPI(
    token: string,
    config: {
      name: string
      workspace_id: string
      project_id: string
      logic_compute_group_id: string
      command: string
      task_priority: number
      spec_id: string
      image: string
      image_type?: ImageType
      instance_count: number
      shm_gi: number
      framework?: string
      auto_fault_tolerance?: boolean
      fault_tolerance_max_retry?: number
    },
  ): Promise<any> {
    const body: Record<string, any> = {
      name: config.name,
      workspace_id: config.workspace_id,
      project_id: config.project_id,
      logic_compute_group_id: config.logic_compute_group_id,
      command: config.command,
      task_priority: config.task_priority,
      framework: config.framework ?? "pytorch",
      auto_fault_tolerance: config.auto_fault_tolerance ?? false,
      framework_config: [
        {
          image: config.image,
          image_type: config.image_type ?? "SOURCE_PRIVATE",
          instance_count: config.instance_count,
          shm_gi: config.shm_gi,
          spec_id: config.spec_id,
        },
      ],
    }
    if (config.auto_fault_tolerance && config.fault_tolerance_max_retry) {
      body.fault_tolerance_max_retry = config.fault_tolerance_max_retry
    }
    return postOpenAPI("/openapi/v1/train_job/create", body, token)
  }

  export async function getJobDetailOpenAPI(token: string, jobId: string): Promise<any> {
    return postOpenAPI("/openapi/v1/train_job/detail", { job_id: jobId }, token)
  }

  export async function stopJobOpenAPI(token: string, jobId: string): Promise<void> {
    await postOpenAPI("/openapi/v1/train_job/stop", { job_id: jobId }, token)
  }

  // --- HPC OpenAPI ---

  export async function createHpcJobOpenAPI(
    token: string,
    config: {
      name: string
      workspace_id: string
      project_id: string
      logic_compute_group_id: string
      entrypoint: string
      image: string
      image_type?: ImageType
      instance_count: number
      spec_id: string
      task_priority: number
      number_of_tasks: number
      cpus_per_task: number
      memory_per_cpu: string
      enable_hyper_threading: boolean
      ttl_after_finish_seconds?: number
    },
  ): Promise<any> {
    const body: Record<string, any> = {
      name: config.name,
      workspace_id: config.workspace_id,
      project_id: config.project_id,
      logic_compute_group_id: config.logic_compute_group_id,
      entrypoint: config.entrypoint,
      image: config.image,
      image_type: config.image_type ?? "SOURCE_PRIVATE",
      instance_count: config.instance_count,
      spec_id: config.spec_id,
      task_priority: config.task_priority,
      number_of_tasks: config.number_of_tasks,
      cpus_per_task: config.cpus_per_task,
      memory_per_cpu: config.memory_per_cpu,
      enable_hyper_threading: config.enable_hyper_threading,
    }
    if (config.ttl_after_finish_seconds) {
      body.ttl_after_finish_seconds = config.ttl_after_finish_seconds
    }
    return postOpenAPI("/openapi/v1/hpc_jobs/create", body, token)
  }

  export async function getHpcJobDetailOpenAPI(token: string, jobId: string): Promise<any> {
    return postOpenAPI("/openapi/v1/hpc_jobs/detail", { job_id: jobId }, token)
  }

  export async function stopHpcJobOpenAPI(token: string, jobId: string): Promise<void> {
    await postOpenAPI("/openapi/v1/hpc_jobs/stop", { job_id: jobId }, token)
  }

  // --- Inference Serving OpenAPI ---

  export async function createInferenceOpenAPI(
    token: string,
    config: {
      name: string
      workspace_id: string
      project_id: string
      logic_compute_group_id: string
      command: string
      image: string
      image_type?: ImageType
      model_id: string
      model_version: number
      port: number
      replicas: number
      node_num_per_replica: number
      task_priority: number
      spec_id: string
      custom_domain?: string
    },
  ): Promise<any> {
    const body: Record<string, any> = {
      name: config.name,
      workspace_id: config.workspace_id,
      project_id: config.project_id,
      logic_compute_group_id: config.logic_compute_group_id,
      command: config.command,
      image: config.image,
      image_type: config.image_type ?? "SOURCE_PUBLIC",
      model_id: config.model_id,
      model_version: config.model_version,
      port: config.port,
      replicas: config.replicas,
      node_num_per_replica: config.node_num_per_replica,
      task_priority: config.task_priority,
      spec_id: config.spec_id,
    }
    if (config.custom_domain) {
      body.custom_domain = config.custom_domain
    }
    return postOpenAPI("/openapi/v1/inference_servings/create", body, token)
  }

  export async function getInferenceDetailOpenAPI(token: string, servingId: string): Promise<any> {
    return postOpenAPI("/openapi/v1/inference_servings/detail", { inference_serving_id: servingId }, token)
  }

  export async function stopInferenceOpenAPI(token: string, servingId: string): Promise<void> {
    await postOpenAPI("/openapi/v1/inference_servings/stop", { inference_serving_id: servingId }, token)
  }

  export function extractSpecId(job: any): string | undefined {
    const fc = job.framework_config ?? []
    const first = fc[0] ?? {}
    return first.instance_spec_price_info?.quota_id ?? first.spec_id ?? undefined
  }

  export async function createJob(cookie: string, config: Record<string, any>): Promise<any> {
    return postInternal("/api/v1/train_job/create", config, cookie, config.workspace_id)
  }

  export async function getJobDetail(cookie: string, jobId: string): Promise<any> {
    return postInternal("/api/v1/train_job/detail", { job_id: jobId }, cookie)
  }

  export async function stopJob(cookie: string, jobId: string): Promise<boolean> {
    try {
      await postInternal("/api/v1/train_job/stop", { job_id: jobId }, cookie)
      return true
    } catch {
      return false
    }
  }

  export async function listJobsWithCookie(
    cookie: string,
    workspaceId: string,
    opts?: { pageNum?: number; pageSize?: number; createdBy?: string },
  ): Promise<{ jobs: any[]; total: number }> {
    const payload: Record<string, any> = {
      page_num: opts?.pageNum ?? 1,
      page_size: opts?.pageSize ?? 100,
      workspace_id: workspaceId,
    }
    if (opts?.createdBy) payload.created_by = opts.createdBy
    const data = await postInternal("/api/v1/train_job/list", payload, cookie, workspaceId)
    return { jobs: data.jobs ?? data.list ?? [], total: data.total ?? 0 }
  }

  export async function listHpcJobs(
    cookie: string,
    workspaceId: string,
    opts?: { status?: string; pageNum?: number; pageSize?: number },
  ): Promise<{ jobs: any[]; total: number }> {
    const payload: Record<string, any> = {
      workspace_id: workspaceId,
      page_num: opts?.pageNum ?? 1,
      page_size: opts?.pageSize ?? 100,
    }
    if (opts?.status) payload.status = opts.status
    const data = await postInternal("/api/v1/hpc_jobs/list", payload, cookie, workspaceId)
    return { jobs: data.jobs ?? data.list ?? [], total: data.total ?? 0 }
  }

  export async function createHpcJob(cookie: string, config: Record<string, any>): Promise<any> {
    return postInternal("/api/v1/hpc_jobs", config, cookie)
  }

  export function extractGpuInfo(job: any): { gpu_count: number; instance_count: number; image: string } {
    const fc = job.framework_config ?? []
    const first = fc[0] ?? {}
    return {
      gpu_count: first.instance_spec_price_info?.gpu_count ?? 0,
      instance_count: first.instance_count ?? 1,
      image: first.image ?? "",
    }
  }

  export function buildJobUrl(jobId: string, workspaceId: string, type: "gpu" | "hpc" | "inference" = "gpu"): string {
    if (type === "hpc") return `${InspireTypes.PLATFORM_URL}/jobs/hpc?spaceId=${workspaceId}`
    if (type === "inference") return `${InspireTypes.PLATFORM_URL}/deploy/inference?spaceId=${workspaceId}`
    return `${InspireTypes.PLATFORM_URL}/jobs/distributedTrainingDetail/${jobId}?spaceId=${workspaceId}`
  }

  export interface TrainLogEntry {
    log_id: string
    message: string
    node: string
    pod_name: string
    time: string
    timestamp_ms: string
    timestamp_str: string
  }

  export async function getTrainLogs(
    cookie: string,
    opts: {
      jobId: string
      instanceCount?: number
      pageSize?: number
      startTimestampMs?: string
      endTimestampMs?: string
    },
  ): Promise<{ logs: TrainLogEntry[]; total: number }> {
    const podNames: string[] = []
    const count = opts.instanceCount ?? 1
    for (let i = 0; i < count; i++) {
      podNames.push(`${opts.jobId}-worker-${i}`)
    }

    const filter: Record<string, any> = { podNames }
    if (opts.startTimestampMs) filter.start_timestamp_ms = opts.startTimestampMs
    if (opts.endTimestampMs) filter.end_timestamp_ms = opts.endTimestampMs

    const body: Record<string, any> = {
      page_size: opts.pageSize ?? 200,
      filter,
      sorter: [
        { field: "time", sort: "descend" },
        { field: "log-id.keyword", sort: "descend" },
      ],
    }

    const data = await postInternal("/api/v1/logs/train", body, cookie)
    return { logs: data.logs ?? [], total: data.total ?? 0 }
  }

  export type MetricType =
    | "gpu_usage_rate"
    | "gpu_memory_usage_rate"
    | "cpu_usage_rate"
    | "memory_usage_rate"
    | "disk_io_read"
    | "disk_io_write"
    | "network_io_read"
    | "network_io_write"
    | "network_storage_io_read"
    | "network_storage_io_write"

  export interface MetricTimeSeries {
    group_name: string
    metric_type: string
    resource_name: string
    time_series: Array<{ data: number; timestamp: string }>
  }

  export async function getClusterMetrics(
    cookie: string,
    opts: {
      computeGroupId: string
      taskId: string
      metricTypes: MetricType[]
      startTimestamp: number
      endTimestamp: number
      intervalSecond?: number
      taskType?: string
      runningRound?: number
    },
  ): Promise<MetricTimeSeries[]> {
    const filter: Record<string, any> = {
      logic_compute_group_id: opts.computeGroupId,
      task_type: opts.taskType ?? "distributed_training",
      task_id: opts.taskId,
    }
    if (opts.runningRound) filter.running_round = opts.runningRound

    const body: Record<string, any> = {
      metric_types: opts.metricTypes,
      filter,
      time_range: {
        start_timestamp: opts.startTimestamp,
        end_timestamp: opts.endTimestamp,
        interval_second: opts.intervalSecond ?? 60,
      },
    }

    const data = await postInternal("/api/v1/cluster_metric/resource_metric_by_time", body, cookie)
    return data.time_seris_metric_groups ?? []
  }

  // --- Notebook ---

  export type NotebookOperation = "START" | "STOP"

  export async function listNotebooks(
    cookie: string,
    workspaceId: string,
    opts?: { page?: number; pageSize?: number },
  ): Promise<{ items: any[]; total: number }> {
    const body: Record<string, any> = {
      workspace_id: workspaceId,
      page_size: opts?.pageSize ?? 100,
      page: opts?.page ?? 1,
    }
    const data = await postInternal("/api/v1/notebook/list", body, cookie, workspaceId)
    return { items: data.list ?? [], total: data.total ?? 0 }
  }

  export async function getNotebookDetail(cookie: string, notebookId: string): Promise<any> {
    const resp = await fetch(`${InspireTypes.PLATFORM_URL}/api/v1/notebook/${notebookId}`, {
      headers: cookieHeaders(cookie),
    })
    if (resp.status === 401) throw Object.assign(new Error("Cookie expired"), { status: 401 })
    const data = (await resp.json()) as any
    if (data.code !== 0) throw new Error(data.message ?? `API error code ${data.code}`)
    return data.data
  }

  export async function operateNotebook(
    cookie: string,
    notebookId: string,
    operation: NotebookOperation,
  ): Promise<void> {
    await postInternal("/api/v1/notebook/operate", { notebook_id: notebookId, operation }, cookie)
  }

  export async function createNotebook(cookie: string, config: Record<string, any>): Promise<any> {
    return postInternal("/api/v1/notebook/create", config, cookie, config.workspace_id)
  }

  export function buildNotebookUrl(notebookId: string, workspaceId: string): string {
    return `${InspireTypes.PLATFORM_URL}/develop/notebook/${notebookId}?spaceId=${workspaceId}`
  }

  // --- Model ---

  export async function listModels(
    cookie: string,
    workspaceId: string,
    opts?: { page?: number; pageSize?: number },
  ): Promise<{ items: any[]; total: number }> {
    const body: Record<string, any> = {
      workspace_id: workspaceId,
      page_size: opts?.pageSize ?? 100,
      page: opts?.page ?? 1,
    }
    const data = await postInternal("/api/v1/model/list", body, cookie, workspaceId)
    return { items: data.list ?? [], total: data.total ?? 0 }
  }

  export async function getModelDetail(cookie: string, modelId: string): Promise<any> {
    const data = await postInternal("/api/v1/model/detail", { model_id: modelId }, cookie)
    return data.model ?? data
  }

  export async function createModel(cookie: string, config: Record<string, any>): Promise<any> {
    return postInternal("/api/v1/model/create", config, cookie, config.workspace_id)
  }

  export async function deleteModel(cookie: string, modelId: string): Promise<void> {
    await postInternal("/api/v1/model/delete", { model_id: modelId }, cookie)
  }
}
