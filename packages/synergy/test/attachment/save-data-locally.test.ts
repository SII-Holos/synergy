import { describe, expect, test } from "bun:test"
import path from "path"
import { Attachment } from "../../src/attachment"
import { Global } from "../../src/global"

function dataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`
}

/**
 * saveDataPartLocally persists channel/chat media into Global.Path.media.
 * Filenames come from external metadata (e.g. Feishu message filenames), so
 * the persisted name must stay collision-free and contained inside the media
 * directory: same-named attachments with different content must not
 * overwrite each other, identical content should reuse one path, and a
 * filename containing path separators must not escape the media directory.
 */
describe("Attachment.saveDataPartLocally", () => {
  test("keeps distinct files for same-named attachments with different content", async () => {
    const first = await Attachment.saveDataPartLocally({
      url: dataUrl(new Uint8Array([1, 2, 3])),
      mime: "image/png",
      filename: "photo.png",
    })
    const second = await Attachment.saveDataPartLocally({
      url: dataUrl(new Uint8Array([4, 5, 6])),
      mime: "image/png",
      filename: "photo.png",
    })
    expect(first).not.toBe(second)
    expect(path.dirname(first)).toBe(path.dirname(second))
    expect(await Bun.file(first).exists()).toBe(true)
    expect(await Bun.file(second).exists()).toBe(true)
  })

  test("reuses the same path for identical content (idempotent)", async () => {
    const bytes = new Uint8Array([7, 8, 9])
    const first = await Attachment.saveDataPartLocally({
      url: dataUrl(bytes),
      mime: "image/png",
      filename: "photo.png",
    })
    const second = await Attachment.saveDataPartLocally({
      url: dataUrl(bytes),
      mime: "image/png",
      filename: "photo.png",
    })
    expect(first).toBe(second)
  })

  test("does not escape the media directory when the filename contains path separators", async () => {
    const localPath = await Attachment.saveDataPartLocally({
      url: dataUrl(new Uint8Array([1])),
      mime: "image/png",
      filename: "../../evil.png",
    })
    const relative = path.relative(Global.Path.media, localPath)
    expect(relative).not.toStartWith("..")
    expect(await Bun.file(localPath).exists()).toBe(true)
  })

  test("saves without a filename using the mime-derived extension", async () => {
    const localPath = await Attachment.saveDataPartLocally({
      url: dataUrl(new Uint8Array([1])),
      mime: "image/jpeg",
    })
    expect(localPath.endsWith(".jpg")).toBe(true)
    expect(await Bun.file(localPath).exists()).toBe(true)
  })

  test("reuses the same path for identical content without a filename", async () => {
    const bytes = new Uint8Array([42])
    const first = await Attachment.saveDataPartLocally({
      url: dataUrl(bytes),
      mime: "image/png",
    })
    const second = await Attachment.saveDataPartLocally({
      url: dataUrl(bytes),
      mime: "image/png",
    })
    expect(first).toBe(second)
  })
})
