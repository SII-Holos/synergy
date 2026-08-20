import { describe, expect, test } from "bun:test"
import {
  FILE_INPUT_ACCEPT,
  formatAttachmentBatchToast,
  formatOversizedAttachmentToast,
  isPromptAttachmentOversized,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_FILES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  partitionPromptAttachmentFiles,
} from "../../../src/components/prompt-input/files"

function file(name: string, type = "", size = 0) {
  return new File([new Uint8Array(size)], name, { type })
}

function oversizedFile(name: string, type = "") {
  return file(name, type, MAX_ATTACHMENT_FILE_BYTES + 1)
}

describe("prompt attachment file support", () => {
  test("accepts any file type as an attachment", () => {
    expect(isPromptAttachmentOversized(file("archive.zip", "application/zip"))).toBe(false)
    expect(isPromptAttachmentOversized(file("clip.mp4", "video/mp4"))).toBe(false)
    expect(isPromptAttachmentOversized(file("song.mp3", "audio/mpeg"))).toBe(false)
    expect(isPromptAttachmentOversized(file("setup.exe", "application/x-msdownload"))).toBe(false)
    expect(isPromptAttachmentOversized(file("payload.bin", "application/octet-stream"))).toBe(false)
    expect(isPromptAttachmentOversized(file("payload"))).toBe(false)
    expect(isPromptAttachmentOversized(file("image.png", "image/png"))).toBe(false)
    expect(isPromptAttachmentOversized(file("notes.txt", "text/plain"))).toBe(false)
  })

  test("rejects files larger than the per-file limit", () => {
    expect(isPromptAttachmentOversized(oversizedFile("big.zip", "application/zip"))).toBe(true)
    expect(isPromptAttachmentOversized(oversizedFile("big.png", "image/png"))).toBe(true)
    expect(isPromptAttachmentOversized(file("exact.bin", "application/octet-stream", MAX_ATTACHMENT_FILE_BYTES))).toBe(
      false,
    )
  })

  test("uses a permissive file picker accept", () => {
    expect(FILE_INPUT_ACCEPT).toBe("*/*")
  })

  test("partitions oversized files without reordering accepted files", () => {
    const files = [
      file("a.bin", "application/octet-stream"),
      oversizedFile("b.bin", "application/octet-stream"),
      file("c.png", "image/png"),
      oversizedFile("d.zip", "application/zip"),
      file("e.pdf", "application/pdf"),
    ]

    const partitioned = partitionPromptAttachmentFiles(files)

    expect(partitioned.accepted.map((item) => item.name)).toEqual(["a.bin", "c.png", "e.pdf"])
    expect(partitioned.rejected.map((item) => item.name)).toEqual(["b.bin", "d.zip"])
  })
})

describe("prompt attachment batch limits", () => {
  test("rejects batches with more than the file-count limit", () => {
    const files = Array.from({ length: MAX_ATTACHMENT_FILES + 1 }, (_, index) => file(`f${index}.txt`))

    expect(formatAttachmentBatchToast(files)).toEqual({
      type: "warning",
      title: "Too many files",
      description: `Choose at most ${MAX_ATTACHMENT_FILES} files.`,
    })
  })

  test("rejects batches whose total size exceeds the limit", () => {
    const files = Array.from({ length: 3 }, (_, index) =>
      file(`f${index}.txt`, "text/plain", Math.ceil(MAX_ATTACHMENT_TOTAL_BYTES / 3)),
    )

    const toast = formatAttachmentBatchToast(files)
    expect(toast?.type).toBe("warning")
    expect(toast?.title).toBe("Files too large")
    expect(toast?.description).toContain(`${MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MB`)
  })

  test("returns no toast for an acceptable batch", () => {
    const files = [file("a.txt", "text/plain"), file("b.png", "image/png")]
    expect(formatAttachmentBatchToast(files)).toBeUndefined()
  })
})

describe("oversized attachment toast copy", () => {
  test("uses a singular warning for one oversized file", () => {
    const toast = formatOversizedAttachmentToast([oversizedFile("big.zip")], 0)

    expect(toast).toEqual({
      type: "warning",
      title: "File too large",
      description: `Too large: big.zip. Files must be ${MAX_ATTACHMENT_FILE_BYTES / (1024 * 1024)} MB or smaller.`,
    })
  })

  test("uses a partial-warning title when some files were accepted", () => {
    const toast = formatOversizedAttachmentToast([oversizedFile("a.zip"), oversizedFile("b.mp4")], 2)

    expect(toast?.title).toBe("Some files were not attached")
    expect(toast?.description).toContain("a.zip, b.mp4")
  })

  test("uses an all-rejected title and truncates long file lists", () => {
    const toast = formatOversizedAttachmentToast(
      [oversizedFile("a.zip"), oversizedFile("b.mp4"), oversizedFile("c.exe"), oversizedFile("d.bin")],
      0,
    )

    expect(toast?.title).toBe("No files attached")
    expect(toast?.description).toContain("a.zip, b.mp4, c.exe, and 1 more")
    expect(toast?.description).not.toContain("d.bin")
  })

  test("returns no toast when nothing was rejected", () => {
    expect(formatOversizedAttachmentToast([], 3)).toBeUndefined()
  })
})
