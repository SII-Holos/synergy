import z from "zod"
import { Tool } from "../tool"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { InspireCache } from "./cache"
import { InspireResolve } from "./resolve"
import { InspireNormalize } from "./normalize"
import { InspireTypes } from "./types"
import { Config } from "../../config/config"

const DESCRIPTION = `Query SII 启智平台 project, workspace, GPU resource, and constraint information. Returns the full decision context in one call: which projects you belong to, which workspaces are available, GPU availability per compute group, available specs, max priority, remaining budget, and storage paths.

启智平台 has multiple workspace types with different network permissions:
- **可上网GPU资源**: has internet (whitelist), for downloading data, setting up environments, light training (usually 4090/T4)
- **分布式训练空间**: NO internet, for large-scale training (H100/H200). Images and data must be prepared in advance
- **CPU资源空间**: has internet, for data transfer and preprocessing
- **高性能计算**: NO internet, Slurm-scheduled CPU tasks
- **国产卡资源空间**: has internet, for Ascend 910B hardware

Call this tool first when starting work on the platform. The returned workspace IDs, compute group IDs, spec IDs, and storage paths are needed for inspire_submit and other tools.`

const parameters = z.object({
  project: z.string().optional().describe("Filter to a specific project (name or ID). Omit to show all projects"),
  workspace: z
    .string()
    .optional()
    .describe("Filter to a specific workspace (name or ID). Omit to show all workspaces for the project"),
  refresh: z.boolean().optional().describe("Force refresh cached data (default false)"),
})

export const InspireStatusTool = Tool.define("inspire_status", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    let projects: any[]
    try {
      projects = await InspireCache.getProjects(params.refresh)
    } catch (err: any) {
      if (String(err).includes("inspire_not_authenticated")) {
        return InspireAuth.notAuthenticatedError("inspire")
      }
      throw err
    }

    if (params.project) {
      const match = await InspireResolve.project(params.project)
      if (match) {
        projects = projects.filter((p: any) => p.id === match.id)
      } else {
        return {
          title: "未找到项目",
          output: `未找到项目 "${params.project}"。可用项目: ${projects.map((p: any) => p.name).join(", ")}`,
          metadata: { error: "project_not_found" } as Record<string, any>,
        }
      }
    }

    const lines: string[] = ["=== 启智平台状态 ===", ""]

    for (const proj of projects) {
      const storagePath = `/inspire/hdd/project/${proj.en_name}/`
      lines.push(`📁 项目: ${proj.name}`)
      lines.push(`   ID: ${proj.id}`)
      lines.push(`   英文名: ${proj.en_name}`)
      lines.push(
        `   最大优先级: ${proj.priority_name}（${proj.priority_level}）${parseInt(proj.priority_name) >= 4 ? "— 优先级 ≥4 的任务不会被抢占" : "— ⚠ 低优先级，任务可能被抢占"}`,
      )

      const budget =
        proj.remain_budget !== undefined && proj.budget !== undefined
          ? `${Math.round(proj.remain_budget)} / ${Math.round(proj.budget)}（剩余 / 总额）`
          : "未知"
      lines.push(`   点券: ${budget}`)
      lines.push(`   存储路径: ${storagePath}`)

      const spaces = proj.space_list ?? []
      const targetSpaces = params.workspace
        ? spaces.filter(
            (s: any) => s.name === params.workspace || s.name.includes(params.workspace!) || s.id === params.workspace,
          )
        : spaces

      for (const space of targetSpaces) {
        const network = InspireTypes.WORKSPACE_NETWORK_MAP[space.name]
        const networkLabel =
          network === "internet" ? "✅ 有外网（白名单限制）" : network === "offline" ? "❌ 无外网" : "未知"
        lines.push("")
        lines.push(`   🖥 空间: ${space.name} (${space.id})`)
        lines.push(`      网络: ${networkLabel}`)

        try {
          const clusterInfo = await InspireCache.getClusterInfo(space.id, params.refresh)
          const computeGroups = clusterInfo?.compute_groups ?? []

          const logicGroups: { id: string; name: string; resourceTypes: string[] }[] = []
          for (const cg of computeGroups) {
            for (const lcg of cg.logic_compute_groups ?? []) {
              logicGroups.push({
                id: lcg.logic_compute_group_id,
                name: lcg.logic_compute_group_name,
                resourceTypes: lcg.resource_types ?? [],
              })
            }
          }

          if (logicGroups.length > 0) {
            lines.push("      计算组:")
            for (const g of logicGroups) {
              let gpuInfo = ""
              try {
                const cookie = await InspireAuth.requireCookie()
                const nodes = await InspireAPI.listNodeDimension(cookie, space.id, g.id)
                const totalGpu = nodes.reduce((sum: number, n: any) => sum + (n.gpu?.total ?? 0), 0)
                const usedGpu = nodes.reduce((sum: number, n: any) => sum + (n.gpu?.used ?? 0), 0)
                const gpuType = nodes[0]?.gpu?.type ?? g.resourceTypes[0] ?? ""
                gpuInfo = `${gpuType ? gpuType + ", " : ""}总 ${totalGpu} GPU, 空闲 ${totalGpu - usedGpu} GPU`
              } catch {
                gpuInfo = "资源信息不可用"
              }

              lines.push(`        - ${g.name} (${g.id}): ${gpuInfo}`)

              try {
                const token = await InspireAuth.requireToken().catch(() => "")
                if (token && !token.startsWith("cookie:")) {
                  const specs = await InspireCache.getSpecs(space.id, g.id, params.refresh)
                  if (specs.length > 0) {
                    lines.push("          可用规格:")
                    for (const spec of specs) {
                      const specId = spec.quota_id ?? spec.id
                      const gpu = spec.gpu_count ?? 0
                      const cpu = spec.cpu_count ?? 0
                      const mem = spec.memory_size_gib ?? 0
                      const gpuType = spec.gpu_info?.gpu_product_simple ?? ""
                      lines.push(`            ${specId}: ${gpu}× ${gpuType || "GPU"}, ${cpu} CPU, ${mem} GB 内存`)
                    }
                  }
                }
              } catch {}
            }
          }
        } catch {}
      }

      lines.push("")
    }

    const constraints: string[] = []
    const hasOffline = projects.some((p: any) =>
      (p.space_list ?? []).some((s: any) => InspireTypes.WORKSPACE_NETWORK_MAP[s.name] === "offline"),
    )
    if (hasOffline) {
      constraints.push("离线空间（分布式训练、高性能计算）无外网：命令中不能包含 pip install / git clone / wget")
    }
    constraints.push(
      "非交互式 shell：命令中需手动 source conda 初始化脚本（如 source /opt/conda/etc/profile.d/conda.sh && conda activate myenv）",
    )
    constraints.push("优先级 1-3 的任务可能被高优任务抢占 kill")

    lines.push("⚠ 提醒:")
    for (const c of constraints) lines.push(`   - ${c}`)

    return {
      title: `${projects.length} 个项目`,
      output: lines.join("\n"),
      metadata: {
        project_count: projects.length,
        project_names: projects.map((p: any) => p.name),
      } as Record<string, any>,
    }
  },
})
