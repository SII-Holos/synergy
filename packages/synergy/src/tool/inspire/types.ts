export namespace InspireTypes {
  export interface Workspace {
    id: string
    name: string
    network?: "internet" | "offline"
  }

  export interface Project {
    id: string
    name: string
    en_name: string
    workspace_id?: string
    priority_level: string
    priority_name: string
    budget: number
    remain_budget: number
    gpu_limit: boolean
    hpc_limit: boolean
    spaces: Workspace[]
  }

  export interface ComputeGroup {
    id: string
    name: string
    workspace_id: string
    gpu_type: string
    gpu_type_display?: string
  }

  export interface Spec {
    id: string
    name?: string
    logic_compute_group_id: string
    logic_compute_group_ids: string[]
    gpu_count: number
    cpu_count: number
    memory_gb: number
    gpu_type: string
    gpu_type_display?: string
  }

  export interface NodeDimension {
    name: string
    status: string
    cordon_type: string
    node_type: "gpu" | "hpc" | string
    gpu: { total: number; used: number; type: string; usage_rate: number }
    cpu: { total: number; used: number; usage_rate: number }
    memory: { total: number; used: number; usage_rate: number }
    logic_compute_group: { id: string; name: string }
  }

  export interface StatusFamily {
    family: "running" | "waiting" | "succeeded" | "failed" | "stopped" | "unknown"
    is_terminal: boolean
    raw: string
  }

  export interface Job {
    job_id: string
    name: string
    status: StatusFamily
    workspace_id: string
    project_id: string
    project_name: string
    command: string
    image: string
    logic_compute_group_id: string
    logic_compute_group_name: string
    gpu_count: number
    instance_count: number
    priority: string
    created_at: string
    finished_at?: string
    running_time_ms?: string
    framework_config: any[]
  }

  export interface InspireAuth {
    username: string
    password: string
    saved_at: number
  }

  export interface HarborAuth {
    username: string
    password: string
    registry: string
    saved_at: number
  }

  export interface TokenCache {
    token: string
    expires_at: number
  }

  export interface HarborRepository {
    name: string
    description: string
    artifact_count: number
    pull_count: number
    update_time: string
  }

  export interface HarborArtifact {
    tags: string[]
    size: number
    push_time: string
    digest: string
    labels: Record<string, string>
  }

  export interface ToolResult {
    title: string
    output: string
    metadata: Record<string, any>
  }

  export const PLATFORM_URL = "https://qz.sii.edu.cn"
  export const HARBOR_REGISTRY = "docker-qb.sii.edu.cn"
  export const HARBOR_PROJECT = "inspire-studio"

  export const BROWSER_HEADERS = {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    "content-type": "application/json",
    origin: PLATFORM_URL,
    pragma: "no-cache",
    "sec-ch-ua": '"Not(A:Brand";v="8", "Chromium";v="144"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  } as const

  export const WORKSPACE_NETWORK_MAP: Record<string, "internet" | "offline"> = {
    可上网GPU资源: "internet",
    CPU资源空间: "internet",
    国产卡资源空间: "internet",
    PPU资源空间: "internet",
    分布式训练空间: "offline",
    高性能计算: "offline",
    整节点任务空间: "offline",
  }
}
