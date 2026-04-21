import { InspireResolve } from "./resolve"
import { InspireAuth } from "./auth"
import { InspireTypes } from "./types"
import { Config } from "../../config/config"

export const STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  waiting: "排队中",
  succeeded: "成功",
  failed: "失败",
  stopped: "已停止",
  unknown: "未知",
}

export function classifyJobId(id: string): "gpu" | "hpc" | "inference" {
  if (id.startsWith("sv-")) return "inference"
  if (id.startsWith("hpc-job-")) return "hpc"
  return "gpu"
}

export async function requireWorkspace(
  workspaceInput?: string,
): Promise<{ ws: { id: string; name: string } } | InspireTypes.ToolResult> {
  const config = await Config.get()
  const sii = config.sii ?? {}
  const wsInput = workspaceInput ?? sii.defaultWorkspace
  if (!wsInput) {
    return {
      title: "缺少工作空间",
      output:
        '未指定 workspace 且未设置 sii.defaultWorkspace。请调用 inspire_status 查看可用空间，或用 inspire_config(action="set", key="defaultWorkspace", value="...") 设置默认值。',
      metadata: { error: "missing_workspace" },
    }
  }
  const ws = await InspireResolve.workspace(wsInput)
  if (!ws) {
    return {
      title: "空间未找到",
      output: `未找到工作空间 "${wsInput}"。请调用 inspire_status 查看可用空间。`,
      metadata: { error: "workspace_not_found" },
    }
  }
  return { ws }
}

export async function requireProject(
  projectInput: string | undefined,
  workspaceId: string,
): Promise<{ proj: { id: string; name: string; en_name: string } } | InspireTypes.ToolResult> {
  const config = await Config.get()
  const sii = config.sii ?? {}
  const projInput = projectInput ?? sii.defaultProject
  const proj = projInput
    ? await InspireResolve.project(projInput, workspaceId)
    : await InspireResolve.firstProject(workspaceId)
  if (!proj) {
    return {
      title: "项目未找到",
      output: "未找到项目。请调用 inspire_status 查看可用项目。",
      metadata: { error: "project_not_found" },
    }
  }
  return { proj }
}
