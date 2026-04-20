import z from "zod"
import { Tool } from "../tool"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { InspireCache } from "./cache"
import { InspireResolve } from "./resolve"
import { InspireTypes } from "./types"
import { Config } from "../../config/config"

const DESCRIPTION = `Submit a GPU training task on the SII 启智平台.

When defaults are configured (via inspire_config), only name and command are required — everything else uses your saved preferences. If commandPrefix is set, it is automatically prepended to your command.

IMPORTANT constraints:
- Offline workspaces (分布式训练空间) have NO internet. Commands must NOT contain pip install, git clone, wget, or any network operations.
- Tasks run in non-interactive shell. ~/.bashrc is NOT loaded. You MUST initialize the environment in the command (or set commandPrefix via inspire_config to do this automatically):
    source /opt/conda/etc/profile.d/conda.sh && conda activate myenv && cd /inspire/hdd/project/{en_name}/code && python train.py
- For distributed training, the platform auto-injects: MASTER_ADDR, PET_NNODES, PET_NODE_RANK, PET_NPROC_PER_NODE.
- Shared memory (shm) matters for multi-GPU training (default 1200 MB).
- Priority must not exceed the project's max (check via inspire_status). Priority ≥4 won't be preempted.

Call inspire_status first to discover resources. Use inspire_config to set defaults for repeated use.`

const parameters = z.object({
  name: z.string().describe("Task name"),
  command: z
    .string()
    .describe(
      "Training command. If commandPrefix is configured, this is appended after it. Otherwise must be self-contained including env init",
    ),
  workspace: z.string().optional().describe("Workspace name or ID. Uses sii.defaultWorkspace if omitted"),
  compute_group: z
    .string()
    .optional()
    .describe("Compute group name or ID. Uses sii.defaultComputeGroup or auto-selects if omitted"),
  project: z.string().optional().describe("Project name or ID. Uses sii.defaultProject or auto-selects if omitted"),
  spec: z.string().optional().describe("Spec/quota ID. Auto-selects the largest GPU spec if omitted"),
  image: z.string().optional().describe("Docker image address. Uses sii.defaultImage if omitted"),
  instances: z.number().optional().describe("Number of nodes (default 1)"),
  shm: z.number().optional().describe("Shared memory MB. Uses sii.defaultShm or 1200 if omitted"),
  priority: z.number().optional().describe("Task priority. Uses sii.defaultPriority or project max if omitted"),
})

export const InspireSubmitTool = Tool.define("inspire_submit", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const config = await Config.get()
    const sii = config.sii ?? {}
    const warnings: string[] = []
    const defaults: string[] = []

    const wsInput = params.workspace ?? sii.defaultWorkspace
    if (!wsInput) {
      return {
        title: "缺少工作空间",
        output:
          '未指定 workspace 且未设置 sii.defaultWorkspace。请调用 inspire_status 查看可用空间，或用 inspire_config(action="set", key="defaultWorkspace", value="...") 设置默认值。',
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
    if (!params.workspace && sii.defaultWorkspace) defaults.push(`空间: ${ws.name} (默认)`)

    const projInput = params.project ?? sii.defaultProject
    const proj = projInput ? await InspireResolve.project(projInput, ws.id) : await InspireResolve.firstProject(ws.id)
    if (!proj) {
      return {
        title: "项目未找到",
        output: "未找到项目。请调用 inspire_status 查看可用项目。",
        metadata: { error: "project_not_found" } as Record<string, any>,
      }
    }
    if (!params.project && sii.defaultProject) defaults.push(`项目: ${proj.name} (默认)`)

    const cgInput = params.compute_group ?? sii.defaultComputeGroup
    const cg = cgInput
      ? await InspireResolve.computeGroup(cgInput, ws.id)
      : await InspireResolve.firstComputeGroup(ws.id)
    if (!cg) {
      return {
        title: "计算组未找到",
        output: "未找到计算组。请调用 inspire_status 查看目标空间的可用计算组。",
        metadata: { error: "compute_group_not_found" } as Record<string, any>,
      }
    }
    if (!params.compute_group && sii.defaultComputeGroup) defaults.push(`计算组: ${cg.name} (默认)`)
    else if (!params.compute_group) warnings.push(`自动选择计算组: ${cg.name}`)

    let specId = params.spec
    let specLabel = specId ?? ""
    const specs = await InspireCache.getSpecs(ws.id, cg.id)
    if (!specId) {
      if (specs.length > 0) {
        const sorted = [...specs].sort((a, b) => (b.gpu_count ?? 0) - (a.gpu_count ?? 0))
        const chosen = sorted[0]
        specId = chosen.quota_id ?? chosen.id
        specLabel = `${chosen.gpu_count ?? 0}× ${chosen.gpu_info?.gpu_product_simple ?? "GPU"}`
        warnings.push(`自动选择规格: ${specLabel}`)
      }
    }

    const image = params.image ?? sii.defaultImage
    if (!image) {
      return {
        title: "缺少镜像",
        output: "未指定 image 且未设置 sii.defaultImage。请用 inspire_images 查找或 inspire_config 设置默认镜像。",
        metadata: { error: "missing_image" } as Record<string, any>,
      }
    }
    if (!params.image && sii.defaultImage) defaults.push(`镜像: ${image} (默认)`)

    const instances = params.instances ?? 1
    const shm = params.shm ?? sii.defaultShm ?? 1200
    if (!params.shm && sii.defaultShm) defaults.push(`共享内存: ${shm} MB (默认)`)

    const projects = await InspireCache.getProjects()
    const projFull = projects.find((p: any) => p.id === proj.id)
    const maxPriority = projFull ? parseInt(projFull.priority_name ?? "4") : 4
    const priority = params.priority ?? sii.defaultPriority ?? maxPriority
    if (priority > maxPriority) {
      return {
        title: "优先级超限",
        output: `优先级 ${priority} 超过项目 "${proj.name}" 最大值 ${maxPriority}。`,
        metadata: { error: "priority_exceeded", max: maxPriority } as Record<string, any>,
      }
    }
    if (!params.priority && sii.defaultPriority) defaults.push(`优先级: ${priority} (默认)`)

    let finalCommand = params.command
    if (sii.commandPrefix) {
      finalCommand = `${sii.commandPrefix} && ${params.command}`
      defaults.push(`命令前缀: ${sii.commandPrefix}`)
    }

    const specInfo =
      specs.length > 0 ? (specs.find((s: any) => (s.quota_id ?? s.id) === specId) ?? specs[0]) : undefined

    const fcCpu = specInfo?.cpu_count ?? 8
    const fcMem = specInfo?.memory_size_gib ?? 64
    const fcGpu = specInfo?.gpu_count ?? 1
    const fcGpuType = specInfo?.gpu_info?.gpu_product_simple ?? ""

    const resourceSpecPrice: Record<string, any> = {
      cpu_count: fcCpu,
      gpu_count: fcGpu,
      memory_size_gib: fcMem,
      logic_compute_group_id: cg.id,
      quota_id: specId ?? "",
    }
    if (fcGpuType) resourceSpecPrice.gpu_type = fcGpuType

    const jobConfig: Record<string, any> = {
      name: params.name,
      workspace_id: ws.id,
      project_id: proj.id,
      logic_compute_group_id: cg.id,
      command: finalCommand,
      task_priority: priority,
      framework: "pytorch",
      auto_fault_tolerance: false,
      enable_notification: false,
      framework_config: [
        {
          image,
          image_type: "SOURCE_PRIVATE",
          instance_count: instances,
          shm_gi: shm,
          cpu: fcCpu,
          mem_gi: fcMem,
          gpu_count: fcGpu,
          resource_spec_price: resourceSpecPrice,
        },
      ],
    }

    let result: any
    try {
      result = await InspireAuth.withCookieRetry((cookie) => InspireAPI.createJob(cookie, jobConfig))
    } catch (err: any) {
      if (String(err).includes("inspire_not_authenticated")) return InspireAuth.notAuthenticatedError("inspire")
      return {
        title: "提交失败",
        output: `任务提交失败: ${err.message ?? err}\n\n常见原因: 镜像不存在、计算组已满、点券不足、需 VPN`,
        metadata: { error: "submit_failed" } as Record<string, any>,
      }
    }

    const jobId = result.job_id ?? result.id ?? ""
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
      `存储路径: /inspire/hdd/project/${proj.en_name}/`,
      `任务页面: ${InspireAPI.buildJobUrl(jobId, ws.id)}`,
    ]

    if (defaults.length > 0) {
      lines.push("", "📋 使用的默认配置:")
      for (const d of defaults) lines.push(`  ${d}`)
    }
    if (warnings.length > 0) {
      lines.push("")
      for (const w of warnings) lines.push(`⚠ ${w}`)
    }

    const network = InspireTypes.WORKSPACE_NETWORK_MAP[ws.name]
    if (network === "offline" && /pip install|git clone|wget |curl /i.test(finalCommand)) {
      lines.push("", "⚠ 警告: 命令中包含联网操作，但目标空间无外网。任务可能会失败。")
    }

    return {
      title: params.name,
      output: lines.join("\n"),
      metadata: { job_id: jobId, workspace_id: ws.id, project_id: proj.id, defaults_used: defaults.length } as Record<
        string,
        any
      >,
    }
  },
})
