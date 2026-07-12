import { describe, expect, test } from "bun:test"
import {
  classifyFilePreview,
  mergeDirectoryPage,
  normalizeWorkspacePath,
  resolveWorkspaceRelativePath,
  shortestUniqueFileTitle,
} from "./model"

describe("file workbench paths", () => {
  test("normalizes separators and rejects workspace escapes", () => {
    expect(normalizeWorkspacePath("./src\\app.ts")).toBe("src/app.ts")
    expect(normalizeWorkspacePath("src/../app.ts")).toBe("app.ts")
    expect(normalizeWorkspacePath("../../secret.txt")).toBeUndefined()
    expect(normalizeWorkspacePath("src/\u0000bad.ts")).toBeUndefined()
  })

  test("uses the shortest unique parent suffix for duplicate names", () => {
    const paths = ["packages/app/index.ts", "packages/tests/index.ts", "README.md"]
    expect(shortestUniqueFileTitle(paths[0]!, paths)).toBe("index.ts · app")
    expect(shortestUniqueFileTitle(paths[1]!, paths)).toBe("index.ts · tests")
    expect(shortestUniqueFileTitle(paths[2]!, paths)).toBe("README.md")
  })

  test("resolves relative Markdown resources inside the workspace only", () => {
    expect(resolveWorkspaceRelativePath("docs/guide/readme.md", "../assets/logo.png")).toBe("docs/assets/logo.png")
    expect(resolveWorkspaceRelativePath("README.md", "../../secret.txt")).toBeUndefined()
    expect(resolveWorkspaceRelativePath("README.md", "javascript:alert(1)")).toBeUndefined()
  })
})

describe("file preview classification", () => {
  test("classifies dual, source-only, preview-only and unsupported files", () => {
    expect(classifyFilePreview("README.md", "text")).toEqual({ kind: "markdown", defaultMode: "preview", dual: true })
    expect(classifyFilePreview("logo.svg", "text")).toEqual({ kind: "svg", defaultMode: "preview", dual: true })
    expect(classifyFilePreview("src/app.ts", "text")).toEqual({ kind: "source", defaultMode: "source", dual: false })
    expect(classifyFilePreview("photo.png", "image")).toEqual({ kind: "image", defaultMode: "preview", dual: false })
    expect(classifyFilePreview("report.pdf", "binary")).toEqual({
      kind: "unsupported",
      defaultMode: "preview",
      dual: false,
    })
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
