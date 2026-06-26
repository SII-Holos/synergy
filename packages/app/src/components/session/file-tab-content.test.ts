import { describe, expect, test } from "bun:test"
import type { WorkspaceFileNode, WorkspaceFileReadResult } from "@ericsanchezok/synergy-sdk"
import { filePreviewModel } from "./file-preview-model"

function node(path: string, binary = false): WorkspaceFileNode {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    type: "file",
    size: 1,
    mtime: 1,
    ctime: 1,
    ignored: false,
    hidden: false,
    readonly: false,
    symlink: false,
    binary,
  }
}

function text(path: string, content: string, mimeType = "text/plain"): WorkspaceFileReadResult {
  return {
    kind: "text",
    path,
    node: node(path),
    content,
    mimeType,
    encoding: "utf-8",
    range: {
      offset: 0,
      limit: 200,
      startLine: 1,
      endLine: content.split(/\r?\n/).length,
    },
    totalBytes: content.length,
    lineCount: content.split(/\r?\n/).length,
    truncated: false,
  }
}

describe("filePreviewModel", () => {
  test("maps text read results to source content", () => {
    const preview = filePreviewModel(text("src/demo.ts", "export const demo = 1"))
    expect(preview.textContent).toContain("demo")
    expect(preview.isImage).toBe(false)
    expect(preview.binaryReason).toBeUndefined()
  })

  test("maps image read results to data URLs", () => {
    const preview = filePreviewModel({
      kind: "image",
      path: "pixel.png",
      node: node("pixel.png", true),
      content: "iVBORw0KGgo=",
      mimeType: "image/png",
      encoding: "base64",
      totalBytes: 8,
      truncated: false,
    })
    expect(preview.isImage).toBe(true)
    expect(preview.imageDataUrl).toBe("data:image/png;base64,iVBORw0KGgo=")
  })

  test("maps SVG text results to source and preview data URLs", () => {
    const preview = filePreviewModel(
      text("icon.svg", `<svg xmlns="http://www.w3.org/2000/svg"></svg>`, "image/svg+xml"),
    )
    expect(preview.isSvg).toBe(true)
    expect(preview.textContent).toContain("<svg")
    expect(preview.svgPreviewUrl?.startsWith("data:image/svg+xml")).toBe(true)
  })

  test("maps binary read results to unsupported preview state", () => {
    const preview = filePreviewModel({
      kind: "binary",
      path: "payload.bin",
      node: node("payload.bin", true),
      totalBytes: 3,
      truncated: false,
      unsupportedReason: "Binary files do not have a text preview",
    })
    expect(preview.binaryReason).toContain("Binary files")
    expect(preview.textContent).toBe("")
  })
})
