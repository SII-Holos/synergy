import z from "zod"
import { Tool } from "../tool"
import { InspireHarbor } from "./harbor"
import { InspireAuth } from "./auth"
import { InspireTypes } from "./types"

const DESCRIPTION = `Push a local Docker image to the SII 启智平台 Harbor registry (${InspireTypes.HARBOR_REGISTRY}/${InspireTypes.HARBOR_PROJECT}/).

Internally runs docker login → docker tag → docker push. Harbor credentials must be configured via 'synergy sii harbor login'.

After pushing, use the returned full image address in inspire_submit's image parameter.

Prerequisites:
- Docker must be installed and running locally
- Harbor credentials configured (synergy sii harbor login)

If this is the first push of a new repository name, you may need to "claim" the image in the platform's Image Management page.`

const parameters = z.object({
  image: z
    .string()
    .describe("Local Docker image name and tag (e.g. 'my-train:v1'). If no tag specified, defaults to 'latest'"),
  name: z
    .string()
    .optional()
    .describe("Remote repository name. Defaults to the image name part. Final path: inspire-studio/{name}"),
  tag: z.string().optional().describe("Remote tag. Defaults to the image tag part"),
  description: z
    .string()
    .optional()
    .describe(
      "Repository description (e.g. 'PyTorch 2.9 + CUDA 12.8 + DeepSpeed'). Set on first push to help identify the image later",
    ),
})

export const InspireImagePushTool = Tool.define("inspire_image_push", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    try {
      const colonIdx = params.image.lastIndexOf(":")
      let parsedName: string
      let parsedTag: string
      if (colonIdx > 0) {
        parsedName = params.image.slice(0, colonIdx)
        parsedTag = params.image.slice(colonIdx + 1)
      } else {
        parsedName = params.image
        parsedTag = "latest"
      }

      const remoteName = params.name ?? parsedName
      const remoteTag = params.tag ?? parsedTag

      const result = await InspireHarbor.pushImage({
        localImage: params.image,
        remoteName,
        remoteTag,
      })

      if (params.description) {
        await InspireHarbor.setDescription(remoteName, params.description)
      }

      const lines = ["=== 镜像推送成功 ===", "", `完整地址: ${result.fullPath}`]
      if (result.digest) lines.push(`Digest: ${result.digest}`)
      lines.push(
        "",
        "可在 inspire_submit 中使用:",
        `  inspire_submit(image="${result.fullPath}", ...)`,
        "",
        "⚠ 如果是首次推送该仓库名，可能需要在平台「镜像管理」页面手动认领镜像。",
      )

      return {
        title: `pushed ${result.fullPath}`,
        output: lines.join("\n"),
        metadata: { fullPath: result.fullPath, digest: result.digest, remoteName, remoteTag } as Record<string, any>,
      }
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? "")

      if (msg.includes("harbor_not_authenticated") || msg.includes("not authenticated")) {
        return InspireAuth.notAuthenticatedError("harbor")
      }
      if (msg.includes("not installed") || msg.includes("not in PATH")) {
        return {
          title: "Docker 未安装",
          output: "Docker 未安装或未运行。请先安装 Docker 并启动 Docker daemon。",
          metadata: { error: "docker_not_installed" } as Record<string, any>,
        }
      }
      if (msg.includes("No such image") || msg.includes("not found locally")) {
        return {
          title: "镜像未找到",
          output: `本地找不到镜像 '${params.image}'。可通过 bash 执行 \`docker images\` 查看本地可用镜像。`,
          metadata: { error: "image_not_found", image: params.image } as Record<string, any>,
        }
      }
      if (
        msg.includes("network") ||
        msg.includes("timeout") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("connection refused")
      ) {
        return {
          title: "推送失败",
          output: "推送失败，请确认处于 VPN 或校园网环境。",
          metadata: { error: "network_error" } as Record<string, any>,
        }
      }

      throw err
    }
  },
})
