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

  export function buildJobUrl(jobId: string, workspaceId: string, type: "gpu" | "hpc" = "gpu"): string {
    if (type === "hpc") return `${InspireTypes.PLATFORM_URL}/jobs/hpc?spaceId=${workspaceId}`
    return `${InspireTypes.PLATFORM_URL}/jobs/distributedTrainingDetail/${jobId}?spaceId=${workspaceId}`
  }
}
