import { describe, expect, test } from "bun:test"
import path from "path"
import { Asset } from "../../src/asset/asset"
import { Global } from "../../src/global"

describe("Asset", () => {
  describe("generateId", () => {
    test("produces consistent id for same content", () => {
      const buffer = Buffer.from("hello world")
      const id1 = Asset.generateId(buffer, "image/png")
      const id2 = Asset.generateId(buffer, "image/png")
      expect(id1).toBe(id2)
    })

    test("produces different ids for different content", () => {
      const id1 = Asset.generateId(Buffer.from("hello"), "image/png")
      const id2 = Asset.generateId(Buffer.from("world"), "image/png")
      expect(id1).not.toBe(id2)
    })

    test("includes correct extension from mime", () => {
      expect(Asset.generateId(Buffer.from("x"), "image/png")).toEndWith(".png")
      expect(Asset.generateId(Buffer.from("x"), "image/jpeg")).toEndWith(".jpg")
      expect(Asset.generateId(Buffer.from("x"), "image/gif")).toEndWith(".gif")
      expect(Asset.generateId(Buffer.from("x"), "image/webp")).toEndWith(".webp")
      expect(Asset.generateId(Buffer.from("x"), "video/mp4")).toEndWith(".mp4")
      expect(Asset.generateId(Buffer.from("x"), "application/pdf")).toEndWith(".pdf")
    })

    test("falls back to .bin for unknown mime", () => {
      const id = Asset.generateId(Buffer.from("x"), "application/unknown")
      expect(id).toEndWith(".bin")
    })

    test("id format is 16-char hex + dot + extension", () => {
      const id = Asset.generateId(Buffer.from("test"), "image/png")
      expect(id).toMatch(/^[a-f0-9]{16}\.png$/)
    })
  })

  describe("write and read", () => {
    test("written asset can be read back", async () => {
      const content = Buffer.from("test asset content")
      const id = await Asset.write(content, "image/png")

      const file = await Asset.read(id)
      expect(file).toBeDefined()

      const readBack = Buffer.from(await file!.arrayBuffer())
      expect(readBack.toString()).toBe("test asset content")
    })

    test("write is idempotent for same content", async () => {
      const content = Buffer.from("idempotent content")
      const id1 = await Asset.write(content, "image/png")
      const id2 = await Asset.write(content, "image/png")
      expect(id1).toBe(id2)
    })

    test("read returns undefined for non-existent asset", async () => {
      const file = await Asset.read("nonexistent_id.png")
      expect(file).toBeUndefined()
    })
  })

  describe("filePath", () => {
    test("resolves to assets directory", () => {
      const p = Asset.filePath("abc123.png")
      expect(p).toBe(path.join(Global.Path.assets, "abc123.png"))
    })
  })

  describe("resolvePath", () => {
    test("returns a safe asset path for valid ids", () => {
      const p = Asset.resolvePath("0123456789abcdef.png")
      expect(p).toBe(path.join(Global.Path.assets, "0123456789abcdef.png"))
    })

    test("rejects invalid or unsafe ids", () => {
      expect(Asset.resolvePath("../evil.txt")).toBeUndefined()
      expect(Asset.resolvePath("not-valid")).toBeUndefined()
      expect(Asset.resolvePath("0123456789abcdef/evil.txt")).toBeUndefined()
    })
  })

  describe("mime helpers", () => {
    test("mimeFromExt returns correct mime types", () => {
      expect(Asset.mimeFromExt("png")).toBe("image/png")
      expect(Asset.mimeFromExt("jpg")).toBe("image/jpeg")
      expect(Asset.mimeFromExt("jpeg")).toBe("image/jpeg")
      expect(Asset.mimeFromExt("gif")).toBe("image/gif")
      expect(Asset.mimeFromExt("svg")).toBe("image/svg+xml")
      expect(Asset.mimeFromExt("mp4")).toBe("video/mp4")
    })

    test("mimeFromExt falls back to octet-stream", () => {
      expect(Asset.mimeFromExt("xyz")).toBe("application/octet-stream")
    })

    test("extFromMime returns correct extensions", () => {
      expect(Asset.extFromMime("image/png")).toBe("png")
      expect(Asset.extFromMime("image/jpeg")).toBe("jpg")
      expect(Asset.extFromMime("video/mp4")).toBe("mp4")
    })

    test("extFromMime returns undefined for unknown mime", () => {
      expect(Asset.extFromMime("application/unknown")).toBeUndefined()
    })

    test("extFromName extracts extension", () => {
      expect(Asset.extFromName("photo.png")).toBe("png")
      expect(Asset.extFromName("my.file.jpg")).toBe("jpg")
      expect(Asset.extFromName("PHOTO.PNG")).toBe("png")
    })

    test("extFromName returns undefined for no extension", () => {
      expect(Asset.extFromName("noext")).toBeUndefined()
    })

    test("extFromId extracts extension from asset id", () => {
      expect(Asset.extFromId("abc123def456.png")).toBe("png")
      expect(Asset.extFromId("abc123def456.jpg")).toBe("jpg")
    })

    test("extFromId falls back to bin", () => {
      expect(Asset.extFromId("abc123def456")).toBe("bin")
    })
  })
})
