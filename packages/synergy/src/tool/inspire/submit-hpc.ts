import z from "zod"
import { Tool } from "../tool"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { InspireCache } from "./cache"
import { InspireResolve } from "./resolve"
import { Config } from "../../config/config"

const DESCRIPTION = `Submit an HPC/CPU task on the SII 启智平台 (Slurm scheduling). Use for data preprocessing, evaluation, CPU-intensive computation, or auxiliary tasks.

HPC spaces (高性能计算) have NO internet. All dependencies must be pre-installed in the image.
HPC tasks must use Slurm-compatible images (images with 'slurm' in the name).
Non-interactive shell: manually source conda in the entrypoint if needed.

Typical use cases:
- Data preprocessing before GPU training
- Reading experiment results from project directories
- File operations across project directories
- Running evaluation scripts that don't need GPU`

const parameters = z.object({
  name: z.string().describe("Task name"),
  entrypoint: z.string().describe("Shell command to execute (Slurm entrypoint)"),
  workspace: z
    .string()
    .optional()
    .describe("Workspace name or ID (e.g. '高性能计算'). Uses sii.defaultWorkspace if omitted"),
  compute_group: z.string().optional().describe("HPC compute group name or ID. Auto-detected if omitted"),
  project: z.string().optional().describe("Project name or ID. Uses default or auto-selects if omitted"),
  cpu: z.number().optional().describe("CPU cores per node (default 8)"),
  mem_gi: z.number().optional().describe("Memory GiB per node (default 32)"),
  image: z.string().optional().describe("Container image. Uses config default if omitted"),
  instances: z.number().optional().describe("Number of nodes (default 1)"),
  predef_quota_id: z.string().optional().describe("Predefined quota ID. Auto-resolved if omitted"),
})

export const InspireSubmitHpcTool = Tool.define("inspire_submit_hpc", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const config = await Config.get()
    const sii = config.sii ?? {}

    const wsInput = params.workspace ?? sii.defaultWorkspace
    if (!wsInput) {
      return {
        title: "缺少工作空间",
        output: "未指定 workspace 且未设置 sii.defaultWorkspace。",
        metadata: { error: "missing_workspace" } as Record<string, any>,
      }
    }
    const ws = await InspireResolve.workspace(wsInput)
    if (!ws) {
      return {
        title: "空间未找到",
        output: `未找到工作空间 "${wsInput}"。请调用 inspire_status 查看可用空间。`,
        metadata: { error: "workspace_not_found" } as Record<string, any>,
      }
    }

    const proj =
      (params.project ?? sii.defaultProject)
        ? await InspireResolve.project((params.project ?? sii.defaultProject)!, ws.id)
        : await InspireResolve.firstProject(ws.id)

    if (!proj) {
      return {
        title: "项目未找到",
        output: "未找到项目。请调用 inspire_status 查看可用项目。",
        metadata: { error: "project_not_found" } as Record<string, any>,
      }
    }

    const cg = params.compute_group
      ? await InspireResolve.computeGroup(params.compute_group, ws.id)
      : await InspireResolve.firstComputeGroup(ws.id)

    if (!cg) {
      return {
        title: "计算组未找到",
        output: "未找到 HPC 计算组。请调用 inspire_status 确认目标空间有 HPC 资源。",
        metadata: { error: "compute_group_not_found" } as Record<string, any>,
      }
    }

    const cpu = params.cpu ?? 8
    const memGi = params.mem_gi ?? 32
    const instances = params.instances ?? 1
    const image = params.image ?? config.sii?.defaultImage
    if (!image) {
      return {
        title: "缺少镜像",
        output: "未指定 image 且 config 中未设置 sii.defaultImage。HPC 任务需要 Slurm 兼容镜像。",
        metadata: { error: "missing_image" } as Record<string, any>,
      }
    }

    let quotaId = params.predef_quota_id
    if (!quotaId) {
      quotaId = InspireCache.getCachedSpecId(ws.id, cg.id)
    }
    if (!quotaId) {
      const resolved = await InspireCache.resolveSpecId(ws.id, cg.id)
      if (resolved) quotaId = resolved
    }
    if (!quotaId) quotaId = ""

    const jobConfig = {
      job_name: params.name,
      workspace_id: ws.id,
      project_id: proj.id,
      logic_compute_group_id: cg.id,
      enable_notification: false,
      dataset_info: [],
      sbatch_script: {
        number_of_tasks: instances,
        cpus_per_task: 1,
        memory_per_cpu: "5G",
        enable_hyper_threading: false,
        max_running_time_days: 0,
        max_running_time_hours: 0,
        max_running_time_minutes: 0,
        entrypoint: params.entrypoint,
      },
      slurm_cluster_spec: {
        predef_quota_id: quotaId,
        cpu,
        mem_gi: memGi,
        image,
        image_type: "SOURCE_PRIVATE",
        instance_count: instances,
        spec_price: {
          cpu_type: "",
          cpu_count: cpu,
          gpu_type: "",
          gpu_count: 0,
          memory_size_gib: memGi,
          logic_compute_group_id: cg.id,
          quota_id: quotaId,
        },
      },
    }

    let result: any
    try {
      result = await InspireAuth.withCookieRetry((cookie) => InspireAPI.createHpcJob(cookie, jobConfig))
    } catch (err: any) {
      if (String(err).includes("inspire_not_authenticated")) {
        return InspireAuth.notAuthenticatedError("inspire")
      }
      return {
        title: "提交失败",
        output: `HPC 任务提交失败: ${err.message ?? err}`,
        metadata: { error: "submit_failed" } as Record<string, any>,
      }
    }

    const jobId = result.job_id ?? result.id ?? ""
    const storagePath = `/inspire/hdd/project/${proj.en_name}/`

    return {
      title: params.name,
      output: [
        "=== HPC 任务提交成功 ===",
        "",
        `任务 ID: ${jobId}`,
        `任务名称: ${params.name}`,
        "状态: 已提交",
        "",
        "配置:",
        `  空间: ${ws.name}`,
        `  项目: ${proj.name}`,
        `  计算组: ${cg.name}`,
        `  CPU: ${cpu} 核`,
        `  内存: ${memGi} GiB`,
        `  节点数: ${instances}`,
        `  镜像: ${image}`,
        "",
        `存储路径: ${storagePath}`,
      ].join("\n"),
      metadata: { job_id: jobId, workspace_id: ws.id, project_id: proj.id } as Record<string, any>,
    }
  },
})
