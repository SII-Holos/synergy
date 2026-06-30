import { describe, expect, test } from "bun:test"
import { resolveAttachmentPresentation, resolveAttachmentThumbnailUrl } from "./attachment-card-utils"

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
