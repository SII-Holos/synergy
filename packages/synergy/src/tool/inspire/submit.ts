import z from "zod"
import { Tool } from "../tool"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { InspireCache } from "./cache"
import { InspireResolve } from "./resolve"
import { InspireTypes } from "./types"
import { Config } from "../../config/config"

const DESCRIPTION = `Submit a GPU training task on the SII 启智平台.

IMPORTANT constraints:
- Offline workspaces (分布式训练空间) have NO internet. Commands must NOT contain pip install, git clone, wget, or any network operations. All dependencies must be pre-installed in the Docker image.
- Tasks run in non-interactive shell. ~/.bashrc is NOT loaded. You MUST initialize the environment in the command:
    source /opt/conda/etc/profile.d/conda.sh && conda activate myenv && cd /inspire/hdd/project/{project_en_name}/code && python train.py
- For distributed training, the platform auto-injects: MASTER_ADDR, PET_NNODES, PET_NODE_RANK, PET_NPROC_PER_NODE. Use them in torchrun:
    torchrun --nnodes \${PET_NNODES} --node_rank \${PET_NODE_RANK} --nproc_per_node \${PET_NPROC_PER_NODE} --master_addr \${MASTER_ADDR} --master_port \${MASTER_PORT} train.py
- Shared memory (shm) matters for multi-GPU training. Default is 1200 MB, increase if needed.
- Priority must not exceed the project's max (check via inspire_status). Priority ≥4 won't be preempted.

Call inspire_status first to find available workspaces, compute groups, specs, and storage paths.`

const parameters = z.object({
  name: z.string().describe("Task name"),
  command: z
    .string()
    .describe(
      "Full bash command including environment initialization. Must be self-contained for non-interactive shell",
    ),
  workspace: z
    .string()
    .describe("Workspace name or ID (e.g. '分布式训练空间'). Use inspire_status to see available options"),
  compute_group: z
    .string()
    .optional()
    .describe("Compute group name or ID. Auto-selects the first available if omitted"),
  project: z.string().optional().describe("Project name or ID. Uses config default or auto-selects if omitted"),
  spec: z.string().optional().describe("Spec/quota ID. Auto-selects the largest GPU spec if omitted"),
  image: z.string().optional().describe("Full Docker image address. Uses config default if omitted"),
  instances: z.number().optional().describe("Number of nodes (default 1)"),
  shm: z
    .number()
    .optional()
    .describe("Shared memory in MB (default from config or 1200). Increase for multi-GPU training"),
  priority: z.number().optional().describe("Task priority (default: project's max). Cannot exceed project's maximum"),
})

export const InspireSubmitTool = Tool.define("inspire_submit", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const config = await Config.get()
    const warnings: string[] = []

    const ws = await InspireResolve.workspace(params.workspace)
    if (!ws) {
      return {
        title: "空间未找到",
        output: `未找到工作空间 "${params.workspace}"。请调用 inspire_status 查看可用空间。`,
        metadata: { error: "workspace_not_found" } as Record<string, any>,
      }
    }

    const proj = params.project
      ? await InspireResolve.project(params.project, ws.id)
      : config.sii?.defaultProject
        ? await InspireResolve.project(config.sii.defaultProject, ws.id)
        : await InspireResolve.firstProject(ws.id)

    if (!proj) {
      return {
        title: "项目未找到",
        output: `未找到项目${params.project ? ` "${params.project}"` : ""}。请调用 inspire_status 查看可用项目，或在 config 中设置 sii.defaultProject。`,
        metadata: { error: "project_not_found" } as Record<string, any>,
      }
    }

    const cg = params.compute_group
      ? await InspireResolve.computeGroup(params.compute_group, ws.id)
      : await InspireResolve.firstComputeGroup(ws.id)

    if (!cg) {
      return {
        title: "计算组未找到",
        output: `未找到计算组${params.compute_group ? ` "${params.compute_group}"` : ""}。请调用 inspire_status 查看目标空间的可用计算组。`,
        metadata: { error: "compute_group_not_found" } as Record<string, any>,
      }
    }
    if (!params.compute_group) warnings.push(`自动选择计算组: ${cg.name}`)

    let specId = params.spec
    let specLabel = specId ?? ""
    if (!specId) {
      const specs = await InspireCache.getSpecs(ws.id, cg.id)
      if (specs.length > 0) {
        const sorted = [...specs].sort((a, b) => (b.gpu_count ?? 0) - (a.gpu_count ?? 0))
        const chosen = sorted[0]
        specId = chosen.quota_id ?? chosen.id
        const gpu = chosen.gpu_count ?? 0
        const gpuType = chosen.gpu_info?.gpu_product_simple ?? "GPU"
        specLabel = `${gpu}× ${gpuType}`
        warnings.push(`自动选择规格: ${specLabel}`)
      }
    }

    const image = params.image ?? config.sii?.defaultImage
    if (!image) {
      return {
        title: "缺少镜像",
        output:
          "未指定 image 且 config 中未设置 sii.defaultImage。请通过 inspire_images 查找可用镜像，或使用 inspire_image_push 推送自定义镜像。",
        metadata: { error: "missing_image" } as Record<string, any>,
      }
    }

    const instances = params.instances ?? 1
    const shm = params.shm ?? config.sii?.defaultShm ?? 1200

    const projects = await InspireCache.getProjects()
    const projFull = projects.find((p: any) => p.id === proj.id)
    const maxPriority = projFull ? parseInt(projFull.priority_name ?? "4") : 4
    const priority = params.priority ?? maxPriority
    if (priority > maxPriority) {
      return {
        title: "优先级超限",
        output: `优先级 ${priority} 超过项目 "${proj.name}" 的最大允许值 ${maxPriority}。请使用 ≤ ${maxPriority} 的优先级。`,
        metadata: { error: "priority_exceeded", max: maxPriority } as Record<string, any>,
      }
    }

    const jobConfig: Record<string, any> = {
      job_name: params.name,
      workspace_id: ws.id,
      project_id: proj.id,
      logic_compute_group_id: cg.id,
      command: params.command,
      priority: priority,
      instance_count: instances,
      enable_notification: false,
    }
    if (specId) jobConfig.spec_id = specId
    if (image) {
      jobConfig.framework_config = [
        {
          image,
          image_type: "SOURCE_PRIVATE",
          instance_count: instances,
          shm_size: shm,
          instance_spec_price_info: specId ? { quota_id: specId } : undefined,
        },
      ]
    }

    let result: any
    try {
      result = await InspireAuth.withTokenRetry((token) => InspireAPI.createJob(token, jobConfig))
    } catch (err: any) {
      if (String(err).includes("inspire_not_authenticated")) {
        return InspireAuth.notAuthenticatedError("inspire")
      }
      return {
        title: "提交失败",
        output: `任务提交失败: ${err.message ?? err}\n\n常见原因:\n- 镜像不存在或无权限\n- 计算组已满\n- 点券不足\n- 网络环境异常（需 VPN 或校园网）`,
        metadata: { error: "submit_failed" } as Record<string, any>,
      }
    }

    const jobId = result.job_id ?? result.id ?? ""
    const storagePath = `/inspire/hdd/project/${proj.en_name}/`
    const jobUrl = InspireAPI.buildJobUrl(jobId, ws.id)

    const lines = [
      "=== 任务提交成功 ===",
      "",
      `任务 ID: ${jobId}`,
      `任务名称: ${params.name}`,
      "状态: 已提交（等待调度）",
      "",
      "配置:",
      `  空间: ${ws.name}`,
      `  项目: ${proj.name}`,
      `  计算组: ${cg.name}`,
      `  规格: ${specLabel || specId || "默认"}`,
      `  镜像: ${image}`,
      `  优先级: ${priority}`,
      `  节点数: ${instances}`,
      `  共享内存: ${shm} MB`,
      "",
      `存储路径: ${storagePath}`,
      `任务页面: ${jobUrl}`,
    ]

    if (warnings.length > 0) {
      lines.push("")
      for (const w of warnings) lines.push(`⚠ ${w}`)
    }

    const network = InspireTypes.WORKSPACE_NETWORK_MAP[ws.name]
    if (network === "offline" && /pip install|git clone|wget |curl /i.test(params.command)) {
      lines.push("")
      lines.push("⚠ 警告: 命令中包含联网操作，但目标空间无外网。任务可能会失败。")
    }

    return {
      title: params.name,
      output: lines.join("\n"),
      metadata: { job_id: jobId, workspace_id: ws.id, project_id: proj.id } as Record<string, any>,
    }
  },
})
