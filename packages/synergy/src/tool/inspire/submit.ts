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
- For distributed training, the platform auto-injects: MASTER_ADDR, MASTER_PORT, PET_NNODES, PET_NODE_RANK, PET_NPROC_PER_NODE.
- Shared memory (shm): multi-GPU training requires ≥64GB (e.g. shm=65536); single-GPU tasks can use the default.
- Priority must not exceed the project's max (check via inspire_status). Priority ≥4 won't be preempted; Priority 1-3 can be killed by higher-priority tasks.
- Low-priority CPU tasks (Priority 1-3) are free and not limited by project budget — useful when budget is exhausted.
- To capture output for debugging, append: 2>&1 | tee /inspire/hdd/project/{en_name}/logs/{job_name}.log
- Images must match the target registry. 七宝 spaces use docker-qb.sii.edu.cn, 松江 spaces use docker.sii.shaipower.online. Mismatched registry causes image pull failure.
- For internet-enabled workspaces, use HF mirror for faster downloads: export HF_ENDPOINT=https://hf-mirror.com

Requires OpenAPI access. If your account has not enabled OpenAPI, this tool will return an error — contact the platform administrator to enable it.

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
  spec: z.string().optional().describe("Spec/quota ID. Uses sii.defaultSpecId or auto-resolves if omitted"),
  image: z.string().optional().describe("Docker image address. Uses sii.defaultImage if omitted"),
  image_type: z
    .enum(["SOURCE_PUBLIC", "SOURCE_PRIVATE", "SOURCE_OFFICIAL"])
    .optional()
    .describe("Image source type (default: SOURCE_PRIVATE)"),
  instances: z.number().optional().describe("Number of nodes (default 1)"),
  shm: z
    .number()
    .optional()
    .describe("Shared memory in MB. Multi-GPU training requires ≥65536. Uses sii.defaultShm or 1200 if omitted"),
  priority: z.number().optional().describe("Task priority. Uses sii.defaultPriority or project max if omitted"),
  auto_fault_tolerance: z
    .boolean()
    .optional()
    .describe("Enable auto fault tolerance (auto-restart on failure). Default: false"),
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

    let specId = params.spec ?? sii.defaultSpecId
    if (!specId) {
      const cached = InspireCache.getCachedSpecId(ws.id, cg.id)
      if (cached) {
        specId = cached
        defaults.push(`规格 ID: ${specId} (缓存)`)
      }
    }
    if (!specId) {
      const resolved = await InspireCache.resolveSpecId(ws.id, cg.id)
      if (resolved) {
        specId = resolved
        warnings.push(`自动解析规格 ID: ${specId}`)
      }
    }
    if (!params.spec && sii.defaultSpecId) defaults.push(`规格 ID: ${specId} (默认)`)
    else if (!params.spec && !sii.defaultSpecId && specId) warnings.push(`使用解析的规格 ID: ${specId}`)

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

    const remainBudget = projFull?.remain_budget ?? undefined
    if (remainBudget !== undefined && remainBudget <= 0) {
      warnings.push(
        `⚠ 项目点券已耗尽（剩余 ${Math.round(remainBudget)}）。任务可能无法创建。低优先级(1-3)的 CPU 任务不受点券限制。`,
      )
    }

    const isSongjangImage = image.includes("docker.sii.shaipower.online")
    const isQibaoImage = image.includes("docker-qb.sii.edu.cn")
    const isSongjangSpace = ws.name.includes("SJ") || ws.name.includes("松江")
    if (isSongjangImage && !isSongjangSpace) {
      warnings.push(
        "⚠ 镜像地址为松江仓库(docker.sii.shaipower.online)，但目标空间可能在七宝集群。镜像拉取可能失败。七宝空间请使用 docker-qb.sii.edu.cn 的镜像。",
      )
    } else if (isQibaoImage && isSongjangSpace) {
      warnings.push(
        "⚠ 镜像地址为七宝仓库(docker-qb.sii.edu.cn)，但目标空间在松江集群。镜像拉取可能失败。松江空间请使用 docker.sii.shaipower.online 的镜像。",
      )
    }

    let finalCommand = params.command
    if (sii.commandPrefix) {
      finalCommand = `${sii.commandPrefix} && ${params.command}`
      defaults.push(`命令前缀: ${sii.commandPrefix}`)
    }

    // OpenAPI only — write operations must use the official API
    let token: string
    try {
      token = await InspireAuth.ensureToken()
    } catch (err: any) {
      if (err instanceof InspireAuth.TokenUnavailableError) {
        if (err.reason === "not_authenticated") {
          return InspireAuth.notAuthenticatedError("inspire")
        }
        if (err.reason === "openapi_not_enabled") {
          return {
            title: "OpenAPI 权限未开通",
            output: [
              "当前账号未开通 OpenAPI 权限，无法提交任务。",
              "",
              "启智平台的任务操作必须通过 OpenAPI 进行。请联系平台管理员开通 OpenAPI 权限。",
              "",
              "验证方式: 在启智平台「个人中心 → OpenAPI」页面查看是否有 Token 管理入口。",
            ].join("\n"),
            metadata: { error: "openapi_not_enabled" } as Record<string, any>,
          }
        }
        return {
          title: "提交失败",
          output: `OpenAPI 认证失败: ${err.message}`,
          metadata: { error: "token_unavailable", reason: err.reason } as Record<string, any>,
        }
      }
      return {
        title: "认证失败",
        output: `无法获取 OpenAPI Token: ${err.message ?? err}`,
        metadata: { error: "token_error" } as Record<string, any>,
      }
    }

    if (!specId) {
      return {
        title: "缺少规格 ID",
        output: [
          "未指定 spec_id 且无法自动解析。",
          "",
          "OpenAPI 提交任务必须提供 spec_id（即 quota_id）。获取方式：",
          "1. 调用 inspire_job_detail 查看已有任务的「规格 ID (quota_id)」",
          '2. 用 inspire_config(action="set", key="defaultSpecId", value="...") 设置默认值',
          "3. 在 inspire_submit 的 spec 参数中直接指定",
        ].join("\n"),
        metadata: { error: "missing_spec_id" } as Record<string, any>,
      }
    }

    let result: any
    try {
      result = await InspireAuth.withTokenRetry((t) =>
        InspireAPI.createJobOpenAPI(t, {
          name: params.name,
          workspace_id: ws.id,
          project_id: proj.id,
          logic_compute_group_id: cg.id,
          command: finalCommand,
          task_priority: priority,
          spec_id: specId!,
          image,
          image_type: params.image_type,
          instance_count: instances,
          shm_gi: shm,
          auto_fault_tolerance: params.auto_fault_tolerance ?? false,
        }),
      )
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      if (msg.includes("spec_id") || msg.includes("SpecId") || msg.includes("spec not found")) {
        return {
          title: "提交失败: 规格 ID 无效",
          output: [
            `spec_id "${specId}" 无效，可能不属于当前空间/计算组。`,
            "",
            "建议:",
            "  1. 用 inspire_job_detail 查看同空间下成功任务的 quota_id",
            '  2. 更新默认值: inspire_config(action="set", key="defaultSpecId", value="正确的quota_id")',
            "  3. 确认镜像地址与空间集群匹配",
          ].join("\n"),
          metadata: { error: "invalid_spec_id", spec_id: specId } as Record<string, any>,
        }
      }
      return {
        title: "提交失败",
        output: `任务提交失败: ${msg}\n\n常见原因: 镜像不存在、计算组已满、点券不足、spec_id 不匹配`,
        metadata: { error: "submit_failed" } as Record<string, any>,
      }
    }

    const jobId = result.job_id ?? result.id ?? ""
    InspireCache.setCachedSpecId(ws.id, cg.id, specId)

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
      `  规格 ID: ${specId}`,
      `  镜像: ${image}`,
      `  优先级: ${priority}`,
      `  节点数: ${instances}`,
      `  共享内存: ${shm} MB`,
    ]

    if (params.auto_fault_tolerance) lines.push(`  容错重启: 已开启`)

    lines.push(
      "",
      `存储路径: /inspire/hdd/project/${proj.en_name}/`,
      `任务页面: ${InspireAPI.buildJobUrl(jobId, ws.id)}`,
    )

    if (defaults.length > 0) {
      lines.push("", "📋 使用的默认配置:")
      for (const d of defaults) lines.push(`  ${d}`)
    }
    if (warnings.length > 0) {
      lines.push("")
      for (const w of warnings) lines.push(w.startsWith("⚠") ? w : `⚠ ${w}`)
    }

    if (instances > 1 && shm < 65536) {
      lines.push("", `⚠ 多机/多卡训练建议共享内存 ≥64GB (当前 ${shm} MB)，可能遇到 NCCL 共享内存错误`)
    }

    const network = InspireTypes.WORKSPACE_NETWORK_MAP[ws.name]
    if (network === "offline" && /pip install|git clone|wget |curl /i.test(finalCommand)) {
      lines.push("", "⚠ 警告: 命令中包含联网操作，但目标空间无外网。任务可能会失败。")
    }

    return {
      title: params.name,
      output: lines.join("\n"),
      metadata: { job_id: jobId, workspace_id: ws.id, project_id: proj.id } as Record<string, any>,
    }
  },
})
