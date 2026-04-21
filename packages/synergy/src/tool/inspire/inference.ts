import z from "zod"
import { Tool } from "../tool"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { InspireCache } from "./cache"
import { InspireResolve } from "./resolve"
import { InspireNormalize } from "./normalize"
import { Config } from "../../config/config"

const DESCRIPTION = `Deploy and manage inference services (模型部署) on the SII 启智平台. Uses the official OpenAPI.

Supports three actions:
- create: Deploy a new inference serving with a model, image, and resource spec
- detail: Get detailed information about an inference serving
- stop: Stop a running inference serving

For create, you need a model_id and model_version. These refer to models registered in the platform's model repository.

Call inspire_status first to discover resources. Use inspire_config to set defaults for repeated use.`

const parameters = z.object({
  action: z.enum(["create", "detail", "stop"]).describe("Action to perform"),
  // Create fields
  name: z.string().optional().describe("Inference serving name (required for create)"),
  command: z.string().optional().describe("Startup command (required for create)"),
  image: z.string().optional().describe("Container image address"),
  image_type: z
    .enum(["SOURCE_PUBLIC", "SOURCE_PRIVATE", "SOURCE_OFFICIAL"])
    .optional()
    .describe("Image source type (default: SOURCE_PUBLIC)"),
  model_id: z.string().optional().describe("Model ID from platform model repository (required for create)"),
  model_version: z.number().optional().describe("Model version number (default: 1)"),
  port: z.number().optional().describe("Service port (default: 2400)"),
  replicas: z.number().optional().describe("Number of inference replicas (default: 1)"),
  node_num_per_replica: z.number().optional().describe("Nodes per replica (default: 1)"),
  custom_domain: z.string().optional().describe("Custom domain for the service"),
  // Detail/Stop fields
  serving_id: z.string().optional().describe("Inference serving ID (sv-xxx, required for detail/stop)"),
  // Shared fields
  workspace: z.string().optional().describe("Workspace name or ID. Uses sii.defaultWorkspace if omitted"),
  compute_group: z.string().optional().describe("Compute group name or ID. Auto-selects if omitted"),
  project: z.string().optional().describe("Project name or ID. Uses default or auto-selects if omitted"),
  spec: z.string().optional().describe("Spec/quota ID. Uses sii.defaultSpecId or auto-resolves if omitted"),
  priority: z.number().optional().describe("Task priority. Uses sii.defaultPriority or project max if omitted"),
})

export const InspireInferenceTool = Tool.define("inspire_inference", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    if (params.action === "create") return handleCreate(params)
    if (params.action === "detail") return handleDetail(params)
    if (params.action === "stop") return handleStop(params)
    return { title: "参数错误", output: "无效的 action", metadata: { error: "invalid_action" } }
  },
})

async function handleCreate(params: z.infer<typeof parameters>) {
  const config = await Config.get()
  const sii = config.sii ?? {}
  const defaults: string[] = []

  if (!params.name) {
    return { title: "缺少名称", output: "创建推理服务需要指定 name", metadata: { error: "missing_name" } }
  }
  if (!params.model_id) {
    return { title: "缺少模型 ID", output: "创建推理服务需要指定 model_id", metadata: { error: "missing_model_id" } }
  }

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
      output: `未找到工作空间 "${wsInput}"。`,
      metadata: { error: "workspace_not_found" } as Record<string, any>,
    }
  }

  const projInput = params.project ?? sii.defaultProject
  const proj = projInput ? await InspireResolve.project(projInput, ws.id) : await InspireResolve.firstProject(ws.id)
  if (!proj) {
    return {
      title: "项目未找到",
      output: "未找到项目。",
      metadata: { error: "project_not_found" } as Record<string, any>,
    }
  }

  const cg = params.compute_group
    ? await InspireResolve.computeGroup(params.compute_group, ws.id)
    : await InspireResolve.firstComputeGroup(ws.id)
  if (!cg) {
    return {
      title: "计算组未找到",
      output: "未找到计算组。请调用 inspire_status 确认。",
      metadata: { error: "compute_group_not_found" } as Record<string, any>,
    }
  }

  const image = params.image ?? sii.defaultImage
  if (!image) {
    return { title: "缺少镜像", output: "未指定 image。", metadata: { error: "missing_image" } as Record<string, any> }
  }

  let specId = params.spec ?? sii.defaultSpecId
  if (!specId) specId = InspireCache.getCachedSpecId(ws.id, cg.id)
  if (!specId) {
    const resolved = await InspireCache.resolveSpecId(ws.id, cg.id)
    if (resolved) specId = resolved
  }
  if (!specId) {
    return {
      title: "缺少规格 ID",
      output: [
        "未指定 spec_id 且无法自动解析。",
        "",
        "获取方式：",
        "1. 调用 inspire_job_detail 查看已有任务的「规格 ID (quota_id)」",
        '2. 用 inspire_config(action="set", key="defaultSpecId", value="...") 设置默认值',
      ].join("\n"),
      metadata: { error: "missing_spec_id" } as Record<string, any>,
    }
  }

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

  let token: string
  try {
    token = await InspireAuth.ensureToken()
  } catch (err: any) {
    if (err instanceof InspireAuth.TokenUnavailableError) {
      if (err.reason === "not_authenticated") return InspireAuth.notAuthenticatedError("inspire")
      return {
        title: "OpenAPI 不可用",
        output: `推理服务创建需要 OpenAPI 权限: ${err.message}`,
        metadata: { error: "token_unavailable" } as Record<string, any>,
      }
    }
    return {
      title: "认证失败",
      output: `无法获取 Token: ${err.message ?? err}`,
      metadata: { error: "token_error" } as Record<string, any>,
    }
  }

  let result: any
  try {
    result = await InspireAuth.withTokenRetry((t) =>
      InspireAPI.createInferenceOpenAPI(t, {
        name: params.name!,
        workspace_id: ws.id,
        project_id: proj.id,
        logic_compute_group_id: cg.id,
        command: params.command ?? "sleep infinity",
        image,
        image_type: params.image_type,
        model_id: params.model_id!,
        model_version: params.model_version ?? 1,
        port: params.port ?? 2400,
        replicas: params.replicas ?? 1,
        node_num_per_replica: params.node_num_per_replica ?? 1,
        task_priority: priority,
        spec_id: specId!,
        custom_domain: params.custom_domain,
      }),
    )
  } catch (err: any) {
    return {
      title: "创建失败",
      output: `推理服务创建失败: ${err.message ?? err}`,
      metadata: { error: "create_failed" } as Record<string, any>,
    }
  }

  const servingId = result.inference_serving_id ?? result.id ?? ""
  InspireCache.setCachedSpecId(ws.id, cg.id, specId)

  const lines = [
    "=== 推理服务创建成功 ===",
    "",
    `服务 ID: ${servingId}`,
    `服务名称: ${params.name}`,
    `模型: ${params.model_id} (v${params.model_version ?? 1})`,
    "状态: 已提交（等待调度）",
    "",
    "配置:",
    `  空间: ${ws.name}`,
    `  项目: ${proj.name}`,
    `  计算组: ${cg.name}`,
    `  规格 ID: ${specId}`,
    `  镜像: ${image}`,
    `  端口: ${params.port ?? 2400}`,
    `  副本数: ${params.replicas ?? 1}`,
    `  优先级: ${priority}`,
    "",
    `服务页面: ${InspireAPI.buildJobUrl(servingId, ws.id, "inference")}`,
  ]

  if (defaults.length > 0) {
    lines.push("", "📋 使用的默认配置:")
    for (const d of defaults) lines.push(`  ${d}`)
  }

  return {
    title: params.name,
    output: lines.join("\n"),
    metadata: { serving_id: servingId, workspace_id: ws.id, project_id: proj.id } as Record<string, any>,
  }
}

async function handleDetail(params: z.infer<typeof parameters>) {
  if (!params.serving_id) {
    return {
      title: "缺少服务 ID",
      output: "查询详情需要指定 serving_id (sv-xxx)",
      metadata: { error: "missing_serving_id" },
    }
  }

  let token: string
  try {
    token = await InspireAuth.ensureToken()
  } catch (err: any) {
    if (err instanceof InspireAuth.TokenUnavailableError && err.reason === "not_authenticated") {
      return InspireAuth.notAuthenticatedError("inspire")
    }
    return {
      title: "认证失败",
      output: `无法获取 Token: ${err.message ?? err}`,
      metadata: { error: "token_error" } as Record<string, any>,
    }
  }

  let serving: any
  try {
    serving = await InspireAuth.withTokenRetry((t) => InspireAPI.getInferenceDetailOpenAPI(t, params.serving_id!))
  } catch (err: any) {
    return {
      title: "查询失败",
      output: `无法获取推理服务 ${params.serving_id} 的详情: ${err.message ?? err}`,
      metadata: { error: "detail_failed", serving_id: params.serving_id } as Record<string, any>,
    }
  }

  const statusInfo = InspireNormalize.status(serving.status ?? "")
  const createdAt = InspireNormalize.formatTimestamp(serving.created_at)
  const url = InspireAPI.buildJobUrl(
    serving.inference_serving_id ?? params.serving_id,
    serving.workspace_id,
    "inference",
  )

  const lines = [
    `=== 推理服务详情: ${serving.name} ===`,
    "",
    "基本信息:",
    `  服务 ID: ${serving.inference_serving_id ?? params.serving_id}`,
    `  状态: ${statusInfo.family} (${statusInfo.raw})`,
    `  创建于: ${createdAt}`,
    "",
    "配置:",
    `  命令: ${serving.command ?? "—"}`,
    `  镜像: ${serving.image ?? "—"}`,
    `  模型: ${serving.model_id ?? "—"} (v${serving.model_version ?? "?"})`,
    `  端口: ${serving.port ?? "—"}`,
    `  副本数: ${serving.replicas ?? "—"}`,
    `  每副本节点: ${serving.node_num_per_replica ?? "—"}`,
    `  优先级: ${serving.task_priority ?? serving.priority_name ?? "—"}`,
    "",
    "归属:",
    `  空间: ${serving.workspace_name ?? "—"} (${serving.workspace_id ?? "—"})`,
    `  项目: ${serving.project_name ?? "—"} (${serving.project_id ?? "—"})`,
    `  计算组: ${serving.logic_compute_group_name ?? "—"}`,
    "",
    `服务页面: ${url}`,
  ]

  if (serving.access_url) {
    lines.push(`访问地址: ${serving.access_url}`)
  }

  return {
    title: `${serving.name} (${statusInfo.family})`,
    output: lines.join("\n"),
    metadata: {
      serving_id: serving.inference_serving_id ?? params.serving_id,
      status: statusInfo.family,
      is_terminal: statusInfo.is_terminal,
    } as Record<string, any>,
  }
}

async function handleStop(params: z.infer<typeof parameters>) {
  if (!params.serving_id) {
    return {
      title: "缺少服务 ID",
      output: "停止服务需要指定 serving_id (sv-xxx)",
      metadata: { error: "missing_serving_id" },
    }
  }

  let token: string
  try {
    token = await InspireAuth.ensureToken()
  } catch (err: any) {
    if (err instanceof InspireAuth.TokenUnavailableError) {
      if (err.reason === "not_authenticated") return InspireAuth.notAuthenticatedError("inspire")
      return {
        title: "停止失败",
        output: `OpenAPI 认证失败: ${err.message}`,
        metadata: { error: "token_unavailable" } as Record<string, any>,
      }
    }
    return {
      title: "认证失败",
      output: `无法获取 Token: ${err.message ?? err}`,
      metadata: { error: "token_error" } as Record<string, any>,
    }
  }

  try {
    await InspireAuth.withTokenRetry((t) => InspireAPI.stopInferenceOpenAPI(t, params.serving_id!))
    return {
      title: `已停止 ${params.serving_id}`,
      output: `✅ 推理服务 ${params.serving_id} 已停止`,
      metadata: { serving_id: params.serving_id, action: "stopped" } as Record<string, any>,
    }
  } catch (err: any) {
    return {
      title: "停止失败",
      output: `无法停止推理服务 ${params.serving_id}: ${err.message ?? err}`,
      metadata: { error: "stop_failed", serving_id: params.serving_id } as Record<string, any>,
    }
  }
}
