import { describe, expect, test } from "bun:test"
import {
  formatUnsupportedAttachmentToast,
  isPromptAttachmentFileAccepted,
  partitionPromptAttachmentFiles,
  SUPPORTED_ATTACHMENT_DESCRIPTION,
} from "./files"

function file(name: string, type = "") {
  return new File(["content"], name, { type })
}

describe("prompt attachment file support", () => {
  test("accepts images, PDF and Office documents", () => {
    expect(isPromptAttachmentFileAccepted(file("image.png", "image/png"))).toBe(true)
    expect(isPromptAttachmentFileAccepted(file("image.jpg", "image/jpeg"))).toBe(true)
    expect(isPromptAttachmentFileAccepted(file("image.gif", "image/gif"))).toBe(true)
    expect(isPromptAttachmentFileAccepted(file("image.webp", "image/webp"))).toBe(true)
    expect(isPromptAttachmentFileAccepted(file("document.pdf", "application/pdf"))).toBe(true)
    expect(
      isPromptAttachmentFileAccepted(
        file("document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      ),
    ).toBe(true)
    expect(
      isPromptAttachmentFileAccepted(
        file("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      ),
    ).toBe(true)
    expect(
      isPromptAttachmentFileAccepted(
        file("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
      ),
    ).toBe(true)
  })

  test("accepts text and code files by MIME or extension", () => {
    expect(isPromptAttachmentFileAccepted(file("notes.txt", "text/plain"))).toBe(true)
    expect(isPromptAttachmentFileAccepted(file("component.ts", "application/octet-stream"))).toBe(true)
    expect(isPromptAttachmentFileAccepted(file("README.md"))).toBe(true)
    expect(isPromptAttachmentFileAccepted(file("data.json", "application/json"))).toBe(true)
    expect(isPromptAttachmentFileAccepted(file("schema.xml", "application/xml"))).toBe(true)
    expect(isPromptAttachmentFileAccepted(file("config.yml", "application/x-yaml"))).toBe(true)
    expect(isPromptAttachmentFileAccepted(file("event.json", "application/vnd.synergy.event+json"))).toBe(true)
    expect(isPromptAttachmentFileAccepted(file("icon.svg", "image/svg+xml"))).toBe(true)
  })

  test("rejects archives, media, executables and arbitrary binary files", () => {
    expect(isPromptAttachmentFileAccepted(file("archive.zip", "application/zip"))).toBe(false)
    expect(isPromptAttachmentFileAccepted(file("archive.tar.gz", "application/gzip"))).toBe(false)
    expect(isPromptAttachmentFileAccepted(file("clip.mp4", "video/mp4"))).toBe(false)
    expect(isPromptAttachmentFileAccepted(file("song.mp3", "audio/mpeg"))).toBe(false)
    expect(isPromptAttachmentFileAccepted(file("setup.exe", "application/x-msdownload"))).toBe(false)
    expect(isPromptAttachmentFileAccepted(file("payload.bin", "application/octet-stream"))).toBe(false)
    expect(isPromptAttachmentFileAccepted(file("payload"))).toBe(false)
  })

  test("partitions mixed files without reordering them", () => {
    const files = [
      file("a.zip", "application/zip"),
      file("b.ts", "application/octet-stream"),
      file("c.png", "image/png"),
      file("d.mp4", "video/mp4"),
      file("e.pdf", "application/pdf"),
    ]

    const partitioned = partitionPromptAttachmentFiles(files)

    expect(partitioned.accepted.map((item) => item.name)).toEqual(["b.ts", "c.png", "e.pdf"])
    expect(partitioned.rejected.map((item) => item.name)).toEqual(["a.zip", "d.mp4"])
  })
})

describe("unsupported prompt attachment toast copy", () => {
  test("uses a singular warning for one rejected file", () => {
    const toast = formatUnsupportedAttachmentToast([file("archive.zip", "application/zip")], 0)

    expect(toast).toEqual({
      type: "warning",
      title: "Unsupported file type",
      description: `Unsupported: archive.zip. ${SUPPORTED_ATTACHMENT_DESCRIPTION}`,
    })
  })

  test("uses a partial-warning title when some files were accepted", () => {
    const toast = formatUnsupportedAttachmentToast(
      [file("archive.zip", "application/zip"), file("clip.mp4", "video/mp4")],
      2,
    )

    expect(toast?.title).toBe("Some files were not attached")
    expect(toast?.description).toContain("archive.zip, clip.mp4")
  })

  test("uses an all-rejected title and truncates long file lists", () => {
    const toast = formatUnsupportedAttachmentToast(
      [
        file("a.zip", "application/zip"),
        file("b.mp4", "video/mp4"),
        file("c.exe", "application/x-msdownload"),
        file("d.bin", "application/octet-stream"),
      ],
      0,
    )

    expect(toast?.title).toBe("No supported files attached")
    expect(toast?.description).toContain("a.zip, b.mp4, c.exe, and 1 more")
    expect(toast?.description).not.toContain("d.bin")
    expect(toast?.description).toContain(SUPPORTED_ATTACHMENT_DESCRIPTION)
  })

  test("returns no toast when every file was accepted", () => {
    expect(formatUnsupportedAttachmentToast([], 3)).toBeUndefined()
  })
})
