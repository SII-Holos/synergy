import { describe, expect, test } from "bun:test"
import {
  attachmentCopyReference,
  attachmentDocumentContext,
  attachmentColumns,
  attachmentSourcePath,
  resolveAttachmentOpenTarget,
  resolveAttachmentPresentation,
  resolveAttachmentThumbnailUrl,
  resolveImagePreviewImage,
} from "../../src/components/attachment-card-utils"

test("attachment copies retain a usable URL or structured source location", () => {
  expect(attachmentCopyReference({ mime: "text/plain" })).toBeUndefined()
  expect(attachmentCopyReference({ mime: "text/plain", assetId: "0123456789abcdef.txt" })).toBe(
    "asset://0123456789abcdef.txt",
  )
  expect(
    attachmentCopyReference({
      mime: "text/plain",
      source: { type: "file", path: "/work/a #.ts", location: { kind: "text", line: 7 } },
    }),
  ).toBe("file:///work/a%20%23.ts#L7")
  expect(
    attachmentCopyReference(
      { mime: "application/pdf", url: "asset://0123456789abcdef.pdf" },
      { kind: "page", page: 3 },
    ),
  ).toBe("asset://0123456789abcdef.pdf#page=3")
})

test("an attached Markdown document resolves relative references from its own parent", () => {
  const workspace = { id: "wsp_original", generation: 2, root: "/original" }
  expect(
    attachmentDocumentContext(
      {
        mime: "text/markdown",
        url: "asset://0123456789abcdef.md",
        source: { type: "file", path: "/original/docs/guide.md", workspace },
      },
      { state: "none" },
    ),
  ).toEqual({ state: "bound", workspace, directory: "docs" })
  expect(
    attachmentDocumentContext({
      mime: "text/markdown",
      url: "asset://0123456789abcdef.md",
      source: { type: "file", path: "/different/guide.md", workspace },
    }),
  ).toEqual({ state: "unresolved" })
})

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
      purpose: "deliverable",
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
      metadata: { thumbnail: { assetId: "1111111111111111.png" } },
    }

    expect(resolveAttachmentPresentation(file).renderer).toBe("thumbnail")
    expect(resolveAttachmentThumbnailUrl("http://localhost:3000", file)).toBe(
      "http://localhost:3000/asset/1111111111111111.png",
    )
  })
})

describe("image preview attachment resolver", () => {
  test("returns preview images for image attachments with asset IDs", () => {
    expect(
      resolveImagePreviewImage(
        "http://localhost:3000",
        { mime: "image/png", assetId: "1111111111111111.png", filename: "plot.png", size: 2048 },
        2,
      ),
    ).toEqual({
      id: "2:1111111111111111.png",
      src: "http://localhost:3000/asset/1111111111111111.png",
      filename: "plot.png",
      mime: "image/png",
      size: 2048,
      alt: "plot.png",
      downloadUrl: "http://localhost:3000/asset/1111111111111111.png",
      externalUrl: "http://localhost:3000/asset/1111111111111111.png",
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
        { mime: "image/png", assetId: "2222222222222222.png", metadata: { attachment: { size: 4096 } } },
        0,
      ),
    ).toMatchObject({ filename: "image", alt: "image", size: 4096 })
  })

  test("carries the source path into image preview gallery items", () => {
    expect(
      resolveImagePreviewImage(
        "http://localhost:3000",
        {
          mime: "image/png",
          assetId: "2222222222222222.png",
          localPath: "/managed/2222222222222222.png",
          source: { type: "file", path: "/workspace/output/plot.png" },
        },
        0,
      ),
    ).toMatchObject({ sourcePath: "/workspace/output/plot.png" })
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

describe("attachment opening policy", () => {
  test("keeps images in the modal and routes located non-images to the attachment workspace", () => {
    expect(
      resolveAttachmentOpenTarget({
        mime: "image/png",
        id: "part-image",
        sessionID: "session-1",
        messageID: "message-1",
      }),
    ).toBe("image-preview")
    expect(
      resolveAttachmentOpenTarget({
        mime: "application/pdf",
        id: "part-pdf",
        sessionID: "session-1",
        messageID: "message-1",
      }),
    ).toBe("attachment-workspace")
    expect(
      resolveAttachmentOpenTarget({
        mime: "video/mp4",
        id: "part-video",
        sessionID: "session-1",
        messageID: "message-1",
      }),
    ).toBe("attachment-workspace")
  })

  test("keeps draft and legacy non-image attachments on the compatibility path", () => {
    expect(resolveAttachmentOpenTarget({ mime: "text/markdown", url: "asset://legacy" })).toBe("compatibility")
  })

  test("resolves source paths in the documented precedence order", () => {
    expect(
      attachmentSourcePath({
        mime: "text/plain",
        localPath: "/workspace/local.txt",
        source: { type: "file", path: "/workspace/source.txt" },
        metadata: { attachment: { sourcePath: "/workspace/metadata.txt" } },
      }),
    ).toBe("/workspace/source.txt")
    expect(
      attachmentSourcePath({ mime: "image/png", url: "asset://0123456789abcdef.png", localPath: "/managed/asset.png" }),
    ).toBeUndefined()
    expect(
      attachmentSourcePath({
        mime: "text/plain",
        source: { type: "file", path: "/workspace/source.txt" },
        metadata: { attachment: { sourcePath: "/workspace/metadata.txt" } },
      }),
    ).toBe("/workspace/source.txt")
    expect(
      attachmentSourcePath({
        mime: "text/plain",
        metadata: { attachment: { sourcePath: "/workspace/metadata.txt" } },
      }),
    ).toBe("/workspace/metadata.txt")
  })
})
