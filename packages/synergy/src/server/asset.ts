import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { Asset } from "../asset/asset"

const AssetInfo = z
  .object({
    id: z.string(),
    url: z.string(),
    mime: z.string(),
    size: z.number(),
  })
  .meta({ ref: "AssetInfo" })

export const AssetRoute = new Hono()

  .post(
    "/",
    describeRoute({
      summary: "Upload asset",
      description: "Upload a binary asset (image, video, etc.) and get a reference URL.",
      operationId: "asset.upload",
      responses: {
        200: {
          description: "Uploaded asset info",
          content: { "application/json": { schema: resolver(AssetInfo) } },
        },
        ...errors(400),
      },
    }),
    validator("form", z.object({ file: z.any() })),
    async (c) => {
      try {
        const { file } = c.req.valid("form")
        if (!(file instanceof File)) return c.json({ message: "Missing file field" }, 400)
        const buffer = Buffer.from(await file.arrayBuffer())
        const mime = file.type || "application/octet-stream"
        const id = await Asset.write(buffer, mime, file.name)
        return c.json({
          id,
          url: `asset://${id}`,
          mime,
          size: buffer.length,
        })
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .get(
    "/:id",
    describeRoute({
      summary: "Get asset",
      description: "Download a previously uploaded asset.",
      operationId: "asset.get",
      responses: {
        200: { description: "Asset binary" },
        ...errors(404),
      },
    }),
    async (c) => {
      const id = c.req.param("id")
      const assetPath = Asset.resolvePath(id)
      if (!assetPath) {
        return c.json({ message: "Invalid asset ID" }, 400)
      }
      const file = Bun.file(assetPath)
      if (!(await file.exists())) {
        return c.json({ message: `Asset not found: ${id}` }, 404)
      }
      c.header("Cache-Control", "public, immutable, max-age=31536000")
      return c.body(file.stream(), {
        headers: { "Content-Type": file.type || "application/octet-stream" },
      })
    },
  )
