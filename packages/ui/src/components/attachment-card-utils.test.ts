import { describe, expect, test } from "bun:test"
import {
  attachmentColumns,
  resolveAttachmentPresentation,
  resolveAttachmentThumbnailUrl,
  resolveImagePreviewImage,
} from "./attachment-card-utils"

describe("attachment presentation resolver", () => {
  test("infers renderers from MIME when no renderer is specified", () => {
    expect(resolveAttachmentPresentation({ mime: "image/png" }).renderer).toBe("image")
    expect(resolveAttachmentPresentation({ mime: "video/mp4" }).renderer).toBe("video")
    expect(resolveAttachmentPresentation({ mime: "audio/mpeg" }).renderer).toBe("audio")
    expect(resolveAttachmentPresentation({ mime: "application/pdf" }).renderer).toBe("file")
  })

  test("uses attachment presentation defaults and explicit overrides", () => {
    expect(
      resolveAttachmentPresentation({
        mime: "application/pdf",
        presentation: { renderer: "file", size: "large", crop: true, hidden: true },
      }),
    ).toEqual({
      renderer: "file",
      size: "large",
      crop: true,
      hidden: true,
    })
  })

  test("uses thumbnail renderer only when thumbnail data exists", () => {
    expect(
      resolveAttachmentPresentation({
        mime: "application/pdf",
        presentation: { renderer: "thumbnail" },
      }).renderer,
    ).toBe("file")

    const file = {
      mime: "application/pdf",
      presentation: { renderer: "thumbnail" as const },
      metadata: { thumbnail: { assetId: "thumb" } },
    }

    expect(resolveAttachmentPresentation(file).renderer).toBe("thumbnail")
    expect(resolveAttachmentThumbnailUrl("http://localhost:3000", file)).toBe("http://localhost:3000/asset/thumb")
  })
})

describe("image preview attachment resolver", () => {
  test("returns preview images for image attachments with asset IDs", () => {
    expect(
      resolveImagePreviewImage(
        "http://localhost:3000",
        { mime: "image/png", assetId: "asset-1", filename: "plot.png", size: 2048 },
        2,
      ),
    ).toEqual({
      id: "2:asset-1",
      src: "http://localhost:3000/asset/asset-1",
      filename: "plot.png",
      mime: "image/png",
      size: 2048,
      alt: "plot.png",
      downloadUrl: "http://localhost:3000/asset/asset-1",
      externalUrl: "http://localhost:3000/asset/asset-1",
    })
  })

  test("returns preview images for data and https URLs", () => {
    expect(
      resolveImagePreviewImage("http://localhost:3000", { mime: "image/png", url: "data:image/png;base64,abc" }, 0)
        ?.src,
    ).toBe("data:image/png;base64,abc")
    expect(
      resolveImagePreviewImage(
        "http://localhost:3000",
        { mime: "image/jpeg", url: "https://example.com/image.jpg", filename: "remote.jpg" },
        1,
      )?.filename,
    ).toBe("remote.jpg")
  })

  test("does not create direct file URL image previews", () => {
    expect(
      resolveImagePreviewImage("http://localhost:3000", { mime: "image/png", url: "file:///tmp/image.png" }, 0),
    ).toBeUndefined()
  })

  test("does not create previews for non-image MIME attachments", () => {
    expect(
      resolveImagePreviewImage(
        "http://localhost:3000",
        { mime: "application/pdf", url: "https://example.com/image.png" },
        0,
      ),
    ).toBeUndefined()
  })

  test("uses default filename and metadata attachment size", () => {
    expect(
      resolveImagePreviewImage(
        "http://localhost:3000",
        { mime: "image/png", assetId: "asset-2", metadata: { attachment: { size: 4096 } } },
        0,
      ),
    ).toMatchObject({ filename: "image", alt: "image", size: 4096 })
  })

  test("keeps duplicate source URLs distinct by visible index", () => {
    const first = resolveImagePreviewImage(
      "http://localhost:3000",
      { mime: "image/png", url: "https://example.com/image.png" },
      0,
    )
    const second = resolveImagePreviewImage(
      "http://localhost:3000",
      { mime: "image/png", url: "https://example.com/image.png" },
      1,
    )

    expect(first?.id).toBe("0:https://example.com/image.png")
    expect(second?.id).toBe("1:https://example.com/image.png")
  })

  test("columnizes generic gallery items with the existing distribution", () => {
    expect(attachmentColumns(["a", "b", "c", "d", "e"])).toEqual([["a", "d"], ["b", "e"], ["c"]])
  })
})
