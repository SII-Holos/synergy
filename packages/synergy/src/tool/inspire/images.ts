import z from "zod"
import { Tool } from "../tool"
import { InspireHarbor } from "./harbor"
import { InspireAuth } from "./auth"
import { InspireTypes } from "./types"

const DESCRIPTION = `Search and browse Docker images in the SII 启智平台 Harbor registry.

Use this to find available training images — check CUDA versions, PyTorch versions, and other dependencies before submitting tasks.

Usage:
- No parameters: list recently pushed images
- search: find images by keyword (matches repository name, e.g. "torch", "cuda12")
- repo: view all versions (tags) of a specific image

Images are stored at ${InspireTypes.HARBOR_REGISTRY}/${InspireTypes.HARBOR_PROJECT}/.
Use inspire_image_push to push new images. Use the full image address in inspire_submit's image parameter.`

const parameters = z.object({
  search: z
    .string()
    .optional()
    .describe("Keyword to search image names (e.g. 'torch', 'cuda12'). If omitted, lists recent images."),
  repo: z
    .string()
    .optional()
    .describe(
      "Repository name to view all tags/versions (e.g. 'dhyu-wan-torch29'). Can include or omit 'inspire-studio/' prefix.",
    ),
  limit: z.number().optional().describe("Number of results to return (default 20, max 100)"),
  offset: z.number().optional().describe("Pagination offset (default 0)"),
})

export const InspireImagesTool = Tool.define("inspire_images", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    try {
      if (params.repo) {
        let repoName = params.repo
        if (repoName.startsWith("inspire-studio/")) repoName = repoName.slice("inspire-studio/".length)

        const artifacts = await InspireHarbor.listArtifacts(repoName, { limit: params.limit ?? 20 })

        const fullName = `${InspireTypes.HARBOR_PROJECT}/${repoName}`
        const lines = [
          `=== 镜像详情: ${fullName} ===`,
          `完整地址: ${InspireTypes.HARBOR_REGISTRY}/${fullName}`,
          "",
          "版本列表:",
        ]

        if (artifacts.length === 0) {
          lines.push("  (无版本)")
        } else {
          for (const a of artifacts) {
            const tags = a.tags.length ? a.tags.join(", ") : "(无 tag)"
            lines.push(`  Tag: ${tags.padEnd(16)} 大小: ${a.size_gb} GB   推送于: ${a.push_time.split("T")[0]}`)
          }
        }

        lines.push(
          "",
          "使用方式:",
          `  在 inspire_submit 的 image 参数中使用: ${InspireTypes.HARBOR_REGISTRY}/${fullName}:{tag}`,
        )

        return {
          title: fullName,
          output: lines.join("\n"),
          metadata: { repo: repoName, artifact_count: artifacts.length } as Record<string, any>,
        }
      }

      const limit = Math.min(params.limit ?? 20, 100)
      const page = Math.floor((params.offset ?? 0) / limit) + 1
      const result = await InspireHarbor.listRepositories({ search: params.search, limit, page })

      const header = params.search ? `=== 镜像搜索: "${params.search}" ===` : `=== 最近推送的镜像 ===`
      const offset = params.offset ?? 0

      const lines = [
        header,
        `共 ${result.total} 个仓库（显示 ${offset + 1}-${offset + result.repositories.length}）:`,
        "",
      ]

      for (let i = 0; i < result.repositories.length; i++) {
        const r = result.repositories[i]
        lines.push(`${offset + i + 1}. ${r.name}`)
        if (r.description) lines.push(`   描述: ${r.description}`)
        lines.push(
          `   版本数: ${r.artifact_count} | 拉取次数: ${r.pull_count} | 更新于: ${r.update_time.split("T")[0]}`,
        )
        lines.push("")
      }

      if (result.total > offset + result.repositories.length) {
        lines.push(`用 offset=${offset + result.repositories.length} 查看下一页`)
        lines.push("")
      }

      lines.push('使用 repo 参数查看某个镜像的所有版本: inspire_images(repo="{name}")')

      return {
        title: `${result.repositories.length} 个镜像`,
        output: lines.join("\n"),
        metadata: { total: result.total, shown: result.repositories.length, offset, limit } as Record<string, any>,
      }
    } catch (err: any) {
      if (String(err).includes("harbor_not_authenticated") || String(err).includes("not authenticated")) {
        return InspireAuth.notAuthenticatedError("harbor")
      }
      throw err
    }
  },
})
