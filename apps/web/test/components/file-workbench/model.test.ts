import { classifyResourcePreview } from "../../../src/components/resource-preview"
import { describe, expect, test } from "bun:test"
import {
  PDF_PREVIEW_MAX_BYTES,
  mergeDirectoryPage,
  normalizeWorkspacePath,
  pdfPreviewAction,
  pdfPreviewBytes,
  shortestUniqueFileTitle,
} from "../../../src/components/file-workbench/model"

describe("file workbench paths", () => {
  test("normalizes separators and rejects workspace escapes", () => {
    expect(normalizeWorkspacePath("./src\\app.ts")).toBe("src/app.ts")
    expect(normalizeWorkspacePath("src/../app.ts")).toBe("app.ts")
    expect(normalizeWorkspacePath("../../secret.txt")).toBeUndefined()
    expect(normalizeWorkspacePath("src/\u0000bad.ts")).toBeUndefined()
  })

  test("uses the shortest unique parent suffix for duplicate names", () => {
    const paths = ["apps/web/index.ts", "packages/tests/index.ts", "README.md"]
    expect(shortestUniqueFileTitle(paths[0]!, paths)).toBe("index.ts · web")
    expect(shortestUniqueFileTitle(paths[1]!, paths)).toBe("index.ts · tests")
    expect(shortestUniqueFileTitle(paths[2]!, paths)).toBe("README.md")
  })
})

describe("file preview classification", () => {
  test("classifies dual, source-only, preview-only and unsupported files", () => {
    expect(classifyResourcePreview("", "README.md", "text")).toMatchObject({
      kind: "markdown",
      defaultMode: "preview",
      dual: true,
    })
    expect(classifyResourcePreview("", "logo.svg", "text")).toMatchObject({
      kind: "svg",
      defaultMode: "preview",
      dual: true,
    })
    expect(classifyResourcePreview("", "page.html", "text")).toMatchObject({
      kind: "html",
      defaultMode: "preview",
      dual: true,
    })
    expect(classifyResourcePreview("", "page.htm", "text")).toMatchObject({
      kind: "html",
      defaultMode: "preview",
      dual: true,
    })
    expect(classifyResourcePreview("", "src/app.ts", "text")).toMatchObject({
      kind: "source",
      defaultMode: "source",
      dual: false,
    })
    expect(classifyResourcePreview("", "photo.png", "image")).toMatchObject({
      kind: "image",
      defaultMode: "preview",
      dual: false,
    })
    expect(classifyResourcePreview("", "report.pdf", "binary")).toMatchObject({
      kind: "pdf",
      defaultMode: "preview",
      dual: false,
    })
    expect(classifyResourcePreview("application/pdf", "report", "binary")).toMatchObject({
      kind: "pdf",
      defaultMode: "preview",
      dual: false,
    })
    expect(classifyResourcePreview("", "deck.pptx", "binary")).toMatchObject({
      kind: "pptx",
      defaultMode: "preview",
      dual: false,
    })
  })

  test("PDF preview action respects the 50 MiB cap and cached bytes", () => {
    expect(pdfPreviewAction({ nodeSize: PDF_PREVIEW_MAX_BYTES + 1, hasBytes: false })).toBe("too-large")
    expect(pdfPreviewAction({ nodeSize: 1024, hasBytes: false })).toBe("fetch")
    expect(pdfPreviewAction({ nodeSize: 1024, hasBytes: true })).toBe("cached")
    expect(pdfPreviewAction({ nodeSize: 1024, hasBytes: true, force: true })).toBe("fetch")
    expect(pdfPreviewAction({ nodeSize: undefined, hasBytes: false })).toBe("fetch")
  })

  test("converts PDF responses to bytes", async () => {
    expect(await pdfPreviewBytes(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]))
    expect(await pdfPreviewBytes(new Uint8Array([1, 2]).buffer)).toEqual(new Uint8Array([1, 2]))
    const blob = new Blob([new Uint8Array([3, 4])], { type: "application/pdf" })
    expect(await pdfPreviewBytes(blob)).toEqual(new Uint8Array([3, 4]))
    expect(await pdfPreviewBytes(null)).toBeUndefined()
  })
})

describe("directory pagination", () => {
  test("merges pages by canonical path without duplicates", () => {
    expect(mergeDirectoryPage(["src/a.ts", "src/b.ts"], ["src/b.ts", "src/c.ts"], false)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ])
    expect(mergeDirectoryPage(["stale.ts"], ["fresh.ts"], true)).toEqual(["fresh.ts"])
  })
})
