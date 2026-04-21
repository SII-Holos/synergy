import z from "zod"
import { Tool } from "../tool"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { InspireNormalize } from "./normalize"
import { InspireResolve } from "./resolve"
import { requireWorkspace, requireProject } from "./shared"
import { Config } from "../../config/config"

const DESCRIPTION = `Search and browse models in the SII 启智平台 model repository.

The primary use case is finding a model_id when creating inference services with inspire_inference.

Supports four actions:
- **list** (default): Browse models in a workspace, optionally filtered by keyword. Shows model_id, name, version, type, vLLM compatibility, and status.
- **detail**: Get full details for a specific model by model_id
- **create**: Register a new model in the repository
- **delete**: Delete a model from the repository

Call inspire_status first to discover workspaces. Use inspire_config to set defaults for repeated use.`

const parameters = z.object({
  action: z.enum(["list", "detail", "create", "delete"]),
  workspace: z.string().optional().describe("Workspace name or ID (uses default if omitted)"),
  project: z.string().optional().describe("Filter to a specific project (name or ID)"),
  offset: z.number().optional().describe("Pagination offset (default 0)"),
  limit: z.number().optional().describe("Max results per page (default 20, max 100)"),
  model_id: z.string().optional().describe("Model ID (UUID, required for detail/delete)"),
  keyword: z.string().optional().describe("Filter by model name keyword"),
  name: z.string().optional().describe("Model name (required for create)"),
  model_source_path: z.string().optional().describe("Source path of model files on platform storage"),
  model_type: z.array(z.string()).optional().describe("Model type tags, e.g. ['NaturalLanguageProcessing']"),
  description: z.string().optional().describe("Model description"),
  tags: z.array(z.string()).optional().describe("Custom tags"),
})

const MODEL_STATUS_MAP: Record<number, string> = {
  1: "上传中",
  2: "就绪",
  3: "异常",
}

export const InspireModelsTool = Tool.define("inspire_models", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const creds = await InspireAuth.getInspireCredentials()
    if (!creds) return InspireAuth.notAuthenticatedError("inspire")

    if (params.action === "list") return handleList(params)
    if (params.action === "detail") return handleDetail(params)
    if (params.action === "create") return handleCreate(params)
    if (params.action === "delete") return handleDelete(params)
    return { title: "参数错误", output: "无效的 action", metadata: { error: "invalid_action" } }
  },
})

async function handleList(params: z.infer<typeof parameters>) {
  const wsResult = await requireWorkspace(params.workspace)
  if (!("ws" in wsResult)) return wsResult
  const ws = wsResult.ws

  const cookie = await InspireAuth.requireCookie()
  const { items, total } = await InspireAuth.withCookieRetry((c) =>
    InspireAPI.listModels(c, ws.id, {
      page: Math.floor((params.offset ?? 0) / (params.limit ?? 20)) + 1,
      pageSize: Math.min(params.limit ?? 20, 100),
    }),
  )

  let filtered = items
  if (params.project) {
    const proj = await InspireResolve.project(params.project, ws.id)
    if (proj) {
      filtered = filtered.filter((item: any) => {
        const m = item.model ?? item
        return item.project_id === proj.id || m.project_id === proj.id
      })
    }
  }
  if (params.keyword) {
    const kw = params.keyword.toLowerCase()
    filtered = filtered.filter((item: any) => {
      const model = item.model ?? item
      return (model.name ?? "").toLowerCase().includes(kw)
    })
  }

  const filterParts: string[] = []
  if (params.project) filterParts.push(`项目: ${params.project}`)
  if (params.keyword) filterParts.push(`关键词: "${params.keyword}"`)
  const filterLabel = filterParts.length ? `（筛选: ${filterParts.join(", ")}，匹配 ${filtered.length}/${total}）` : ""

  const lines = [`=== 模型列表 ===`, `空间: ${ws.name}`, `共 ${total} 个模型${filterLabel}`, ""]

  if (filtered.length === 0) {
    lines.push(params.keyword ? `未找到包含 "${params.keyword}" 的模型` : "暂无模型")
  } else {
    for (let i = 0; i < filtered.length; i++) {
      const item = filtered[i]
      const m = item.model ?? item
      const modelId = m.model_id ?? ""
      const version = m.version ?? 1
      const typeTags = Array.isArray(m.model_type) ? m.model_type.join(", ") : ""
      const vllm = m.is_vllm_compatible ? "✅" : "❌"
      const status = MODEL_STATUS_MAP[m.status] ?? String(m.status ?? "")
      const projectName = item.project_name ?? ""
      const offset = params.offset ?? 0

      lines.push(`${offset + i + 1}. ${m.name ?? "未命名"}`)
      lines.push(`   model_id: ${modelId}`)
      lines.push(`   版本: ${version} | 类型: ${typeTags || "—"} | vLLM: ${vllm} | 状态: ${status}`)
      if (projectName) lines.push(`   项目: ${projectName}`)
      lines.push("")
    }

    if (total > items.length + (params.offset ?? 0)) {
      lines.push(`显示 ${filtered.length}/${total}，还有更多。用 offset=${(params.offset ?? 0) + items.length} 翻页`)
      lines.push("")
    }

    lines.push("💡 创建推理服务时需要 model_id，可从上方复制。")
    lines.push('   示例: inspire_inference(action="create", model_id="...", ...)')
  }

  return {
    title: `${filtered.length} 个模型`,
    output: lines.join("\n"),
    metadata: {
      total,
      filtered: filtered.length,
      workspace_id: ws.id,
      project: params.project,
      keyword: params.keyword,
    } as Record<string, any>,
  }
}

async function handleDetail(params: z.infer<typeof parameters>) {
  if (!params.model_id) {
    return {
      title: "缺少模型 ID",
      output: "查询详情需要指定 model_id",
      metadata: { error: "missing_model_id" },
    }
  }

  const cookie = await InspireAuth.requireCookie()
  let model: any
  try {
    model = await InspireAuth.withCookieRetry((c) => InspireAPI.getModelDetail(c, params.model_id!))
  } catch (err: any) {
    return {
      title: "查询失败",
      output: `无法获取模型 ${params.model_id} 的详情: ${err.message ?? err}`,
      metadata: { error: "detail_failed", model_id: params.model_id } as Record<string, any>,
    }
  }

  // Detail API returns unreliable zero-values for status/version/is_vllm_compatible.
  // Supplement from list if all three are zero/missing.
  if (!model.status && !model.version && !model.is_vllm_compatible && model.workspace_id) {
    try {
      const { items } = await InspireAuth.withCookieRetry((c) =>
        InspireAPI.listModels(c, model.workspace_id, { pageSize: 100 }),
      )
      const match = items.find((item: any) => item.model?.model_id === params.model_id)
      if (match?.model) {
        model = { ...model, ...match.model, model_id: model.model_id }
      }
    } catch {}
  }

  const typeTags = Array.isArray(model.model_type) ? model.model_type.join(", ") : ""
  const vllm = model.is_vllm_compatible === true ? "✅ 兼容" : model.is_vllm_compatible === false ? "❌ 不兼容" : "—"
  const statusNum = model.status
  const status =
    statusNum && MODEL_STATUS_MAP[statusNum] ? MODEL_STATUS_MAP[statusNum] : statusNum ? String(statusNum) : "—"
  const version = model.version || "—"
  const createdAt = InspireNormalize.formatTimestamp(model.created_at)
  const tagList = Array.isArray(model.tags) ? model.tags.join(", ") : ""

  const lines = [
    `=== 模型详情: ${model.name ?? "未命名"} ===`,
    "",
    "基本信息:",
    `  model_id: ${model.model_id ?? params.model_id}`,
    `  版本: ${version}`,
    `  状态: ${status}`,
    `  vLLM: ${vllm}`,
    `  类型: ${typeTags || "—"}`,
    "",
    "存储:",
    `  模型路径: ${model.model_path || "—"}`,
    `  源路径: ${model.model_source_path || "—"}`,
    "",
    "描述:",
    `  ${model.description || "（无描述）"}`,
    "",
    "标签:",
    `  ${tagList || "（无标签）"}`,
    "",
    "归属:",
    `  项目 ID: ${model.project_id ?? "—"}`,
    `  创建者: ${model.user_name ?? "—"}`,
    `  创建于: ${createdAt || "—"}`,
  ]

  return {
    title: `${model.name ?? params.model_id}${status !== "—" ? ` (${status})` : ""}`,
    output: lines.join("\n"),
    metadata: {
      model_id: model.model_id ?? params.model_id,
      name: model.name,
      version: model.version,
      status,
      is_vllm_compatible: model.is_vllm_compatible,
    } as Record<string, any>,
  }
}

async function handleCreate(params: z.infer<typeof parameters>) {
  if (!params.name) {
    return {
      title: "缺少模型名称",
      output: "创建模型需要指定 name",
      metadata: { error: "missing_name" },
    }
  }

  const wsResult = await requireWorkspace(params.workspace)
  if (!("ws" in wsResult)) return wsResult
  const ws = wsResult.ws

  const config = await Config.get()
  const sii = config.sii ?? {}
  const projResult = await requireProject(undefined, ws.id)
  if (!("proj" in projResult)) return projResult
  const proj = projResult.proj
  if (!proj) {
    return {
      title: "项目未找到",
      output: "未找到项目。请通过 sii.defaultProject 设置默认项目。",
      metadata: { error: "project_not_found" } as Record<string, any>,
    }
  }

  const cookie = await InspireAuth.requireCookie()

  const body: Record<string, any> = {
    workspace_id: ws.id,
    project_id: proj.id,
    name: params.name,
  }
  if (params.model_source_path) body.model_source_path = params.model_source_path
  if (params.model_type) body.model_type = params.model_type
  if (params.description) body.description = params.description
  if (params.tags) body.tags = params.tags

  let result: any
  try {
    result = await InspireAuth.withCookieRetry((c) => InspireAPI.createModel(c, body))
  } catch (err: any) {
    return {
      title: "创建失败",
      output: `模型创建失败: ${err.message ?? err}`,
      metadata: { error: "create_failed" } as Record<string, any>,
    }
  }

  const createdId = result.model_id ?? result.id ?? ""

  const lines = [
    "=== 模型创建成功 ===",
    "",
    `model_id: ${createdId}`,
    `名称: ${params.name}`,
    `空间: ${ws.name}`,
    `项目: ${proj.name}`,
    "",
    "💡 可使用此 model_id 创建推理服务:",
    `   inspire_inference(action="create", model_id="${createdId}", ...)`,
  ]

  return {
    title: params.name,
    output: lines.join("\n"),
    metadata: { model_id: createdId, workspace_id: ws.id, project_id: proj.id } as Record<string, any>,
  }
}

async function handleDelete(params: z.infer<typeof parameters>) {
  if (!params.model_id) {
    return {
      title: "缺少模型 ID",
      output: "删除模型需要指定 model_id",
      metadata: { error: "missing_model_id" },
    }
  }

  const cookie = await InspireAuth.requireCookie()
  try {
    await InspireAuth.withCookieRetry((c) => InspireAPI.deleteModel(c, params.model_id!))
  } catch (err: any) {
    return {
      title: "删除失败",
      output: `模型删除失败: ${err.message ?? err}`,
      metadata: { error: "delete_failed", model_id: params.model_id } as Record<string, any>,
    }
  }

  return {
    title: `已删除 ${params.model_id}`,
    output: `✅ 模型 ${params.model_id} 已删除`,
    metadata: { model_id: params.model_id, action: "deleted" } as Record<string, any>,
  }
}
