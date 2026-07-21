import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { ScopeContext } from "../../src/scope/context"
import { WorkspaceFileIndexer } from "../../src/workspace-file/indexer"
import { WorkspaceFileSearch } from "../../src/workspace-file/search"
import { WorkspaceFileService } from "../../src/workspace-file/service"
import { WorkspaceFileStatus } from "../../src/workspace-file/status"
import { LSP } from "../../src/lsp"
import { Ripgrep } from "../../src/file/ripgrep"
import { tmpdir } from "../fixture/fixture"

function isSymlinkPrivilegeError(error: unknown) {
  const code = (error as { code?: unknown })?.code
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES")
}

async function trySymlink(target: string, linkPath: string) {
  try {
    await fs.symlink(target, linkPath, "file")
    return true
  } catch (error) {
    if (isSymlinkPrivilegeError(error)) return false
    throw error
  }
}

async function withWorkspace<T>(init: (dir: string) => Promise<void>, fn: (dir: string) => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true, init })
  return ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      WorkspaceFileIndexer.invalidate()
      try {
        return await fn(tmp.path)
      } finally {
        WorkspaceFileIndexer.invalidate()
      }
    },
  })
}

describe("WorkspaceFileService", () => {
  test("rejects traversal, prefix collisions, and symlink escapes", async () => {
    const sibling = path.join(os.tmpdir(), `synergy-test-sibling-${Date.now()}`)
    await fs.mkdir(sibling, { recursive: true })
    await Bun.write(path.join(sibling, "outside.txt"), "outside")
    let symlinkCreated = false

    try {
      await withWorkspace(
        async (dir) => {
          await Bun.write(path.join(dir, "inside.txt"), "inside")
          symlinkCreated = await trySymlink(path.join(sibling, "outside.txt"), path.join(dir, "outside-link.txt"))
        },
        async () => {
          expect(() => WorkspaceFileService.resolve("../outside.txt")).toThrow(/escapes workspace/)
          await expect(WorkspaceFileService.node(path.join(sibling, "outside.txt"))).rejects.toThrow(
            /escapes workspace/,
          )
          if (symlinkCreated) {
            await expect(WorkspaceFileService.node("outside-link.txt")).rejects.toThrow(/escapes workspace/)
          }

          const inside = await WorkspaceFileService.node("inside.txt")
          expect(inside.path).toBe("inside.txt")
          expect(inside.type).toBe("file")
        },
      )
    } finally {
      await fs.rm(sibling, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("returns lazy directory children with stable sorting and cursor pagination", async () => {
    await withWorkspace(
      async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await fs.mkdir(path.join(dir, "node_modules"), { recursive: true })
        await Bun.write(path.join(dir, "README.md"), "readme")
        await Bun.write(path.join(dir, "alpha.txt"), "alpha")
        await Bun.write(path.join(dir, ".env"), "SECRET=1")
        await Bun.write(path.join(dir, "node_modules", "pkg.js"), "module")
      },
      async () => {
        const root = await WorkspaceFileService.children({ path: "" })
        const names = root.children.map((item) => item.name)
        expect(names).toContain("src")
        expect(names).toContain("alpha.txt")
        expect(names).not.toContain(".env")
        expect(names).not.toContain("node_modules")
        expect(names.indexOf("src")).toBeLessThan(names.indexOf("alpha.txt"))

        const all = await WorkspaceFileService.children({ path: "", showHidden: true, showIgnored: true })
        expect(all.children.map((item) => item.name)).toContain(".env")
        expect(all.children.map((item) => item.name)).toContain("node_modules")

        const hiddenOnly = await WorkspaceFileService.children({ path: "", showHidden: true })
        expect(hiddenOnly.children.map((item) => item.name)).toContain(".env")
        expect(hiddenOnly.children.map((item) => item.name)).not.toContain("node_modules")

        const ignoredOnly = await WorkspaceFileService.children({ path: "", showIgnored: true })
        expect(ignoredOnly.children.map((item) => item.name)).not.toContain(".env")
        expect(ignoredOnly.children.map((item) => item.name)).toContain("node_modules")

        const first = await WorkspaceFileService.children({ path: "", limit: 1, showHidden: true, showIgnored: true })
        expect(first.children).toHaveLength(1)
        expect(first.truncated).toBe(true)
        expect(first.nextCursor).toBeDefined()

        const second = await WorkspaceFileService.children({
          path: "",
          limit: 1,
          cursor: first.nextCursor,
          showHidden: true,
          showIgnored: true,
        })
        expect(second.children).toHaveLength(1)
        expect(second.children[0]?.path).not.toBe(first.children[0]?.path)
      },
    )
  })

  test("reports internal and broken symlinks without escaping the Scope", async () => {
    let supported = true
    await withWorkspace(
      async (dir) => {
        await Bun.write(path.join(dir, "target.txt"), "inside")
        supported = await trySymlink(path.join(dir, "target.txt"), path.join(dir, "internal-link.txt"))
        if (!supported) return
        await fs.symlink(path.join(dir, "missing.txt"), path.join(dir, "broken-link.txt"), "file")
      },
      async () => {
        if (!supported) return
        const internal = await WorkspaceFileService.node("internal-link.txt")
        expect(internal.symlink).toBe(true)
        expect(internal.type).toBe("file")

        const broken = await WorkspaceFileService.node("broken-link.txt")
        expect(broken.symlink).toBe(true)
        expect(broken.type).toBe("symlink")
      },
    )
  })

  test("attaches git status metadata to nodes and status summaries", async () => {
    await withWorkspace(
      async (dir) => {
        await Bun.write(path.join(dir, "tracked.txt"), "old\n")
        await $`git add tracked.txt`.cwd(dir).quiet()
        await $`git commit -m baseline`.cwd(dir).quiet()
        await Bun.write(path.join(dir, "tracked.txt"), "old\nnew\n")
        await Bun.write(path.join(dir, "untracked.txt"), "fresh\n")
      },
      async () => {
        WorkspaceFileStatus.invalidate()

        const summary = await WorkspaceFileStatus.summary({ force: true })
        expect(summary.files.find((file) => file.path === "tracked.txt")?.status).toBe("modified")
        expect(summary.files.find((file) => file.path === "untracked.txt")?.status).toBe("untracked")

        const tracked = await WorkspaceFileService.node("tracked.txt")
        expect(tracked.gitStatus).toBe("modified")

        const children = await WorkspaceFileService.children({ path: "" })
        expect(children.children.find((node) => node.path === "untracked.txt")?.gitStatus).toBe("untracked")
      },
    )
  })

  test("reads text ranges, images, svg text, and binary metadata", async () => {
    await withWorkspace(
      async (dir) => {
        await Bun.write(path.join(dir, "notes.txt"), "one\ntwo\nthree\nfour\n")
        await Bun.write(path.join(dir, "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg"></svg>`)
        await Bun.write(path.join(dir, "pixel.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        await Bun.write(path.join(dir, "payload.bin"), new Uint8Array([0x00, 0x01, 0x02]))
      },
      async () => {
        const text = await WorkspaceFileService.read({ path: "notes.txt", offset: 1, limit: 2 })
        expect(text.kind).toBe("text")
        if (text.kind === "text") {
          expect(text.content).toBe("two\nthree")
          expect(text.truncated).toBe(true)
          expect(text.nextRange?.offset).toBe(3)
        }

        const svg = await WorkspaceFileService.read({ path: "icon.svg" })
        expect(svg.kind).toBe("text")
        if (svg.kind === "text") expect(svg.mimeType).toBe("image/svg+xml")

        const image = await WorkspaceFileService.read({ path: "pixel.png" })
        expect(image.kind).toBe("image")
        if (image.kind === "image") {
          expect(image.mimeType).toBe("image/png")
          expect(image.content.length).toBeGreaterThan(0)
        }

        const binary = await WorkspaceFileService.read({ path: "payload.bin" })
        expect(binary.kind).toBe("binary")
        if (binary.kind === "binary") expect(binary.unsupportedReason).toContain("Binary files")
      },
    )
  })

  test("returns complete documents up to 4 MiB", async () => {
    await withWorkspace(
      async (dir) => {
        await Bun.write(path.join(dir, "document.txt"), "one\ntwo\nthree\n")
      },
      async () => {
        const result = await WorkspaceFileService.read({ path: "document.txt", mode: "document" })
        expect(result.kind).toBe("text")
        if (result.kind === "text") {
          expect(result.content).toBe("one\ntwo\nthree\n")
          expect(result.truncated).toBe(false)
          expect(result.nextRange).toBeUndefined()
          expect(result.truncationReason).toBeUndefined()
        }
      },
    )
  })

  test("keeps the exact 4 MiB document boundary complete", async () => {
    await withWorkspace(
      async (dir) => {
        await Bun.write(path.join(dir, "boundary.txt"), "x".repeat(4 * 1024 * 1024))
      },
      async () => {
        const result = await WorkspaceFileService.read({ path: "boundary.txt", mode: "document" })
        expect(result.kind).toBe("text")
        if (result.kind === "text") {
          expect(result.totalBytes).toBe(4 * 1024 * 1024)
          expect(result.content.length).toBe(4 * 1024 * 1024)
          expect(result.truncated).toBe(false)
          expect(result.truncationReason).toBeUndefined()
        }
      },
    )
  })

  test("returns a bounded document preview for text over 4 MiB without a continuation range", async () => {
    await withWorkspace(
      async (dir) => {
        const line = "x".repeat(1024)
        await Bun.write(path.join(dir, "large.txt"), Array.from({ length: 5000 }, () => line).join("\n"))
      },
      async () => {
        const result = await WorkspaceFileService.read({ path: "large.txt", mode: "document" })
        expect(result.kind).toBe("text")
        if (result.kind === "text") {
          expect(result.truncated).toBe(true)
          expect(result.totalBytes).toBeGreaterThan(4 * 1024 * 1024)
          expect(result.lineCount).toBeUndefined()
          expect(result.content.length).toBeLessThanOrEqual(512 * 1024)
          expect(result.nextRange).toBeUndefined()
          expect(result.truncationReason).toBe("size")
        }
      },
    )
  })

  test("keeps range reads paginated", async () => {
    await withWorkspace(
      async (dir) => {
        await Bun.write(path.join(dir, "range.txt"), "one\ntwo\nthree\nfour\n")
      },
      async () => {
        const result = await WorkspaceFileService.read({ path: "range.txt", mode: "range", limit: 2 })
        expect(result.kind).toBe("text")
        if (result.kind === "text") {
          expect(result.content).toBe("one\ntwo")
          expect(result.truncated).toBe(true)
          expect(result.nextRange?.offset).toBe(2)
          expect(result.truncationReason).toBe("range")
        }
      },
    )
  })
})

describe("WorkspaceFileSearch", () => {
  test("returns fuzzy file matches with score, indices, and node metadata", async () => {
    await withWorkspace(
      async (dir) => {
        await fs.mkdir(path.join(dir, "src", "components"), { recursive: true })
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await Bun.write(path.join(dir, "src", "components", "file-panel.tsx"), "export const FilePanel = 1")
        await Bun.write(path.join(dir, "src", "components", "other.tsx"), "export const Other = 1")
        await Bun.write(path.join(dir, "docs", "file-panel.md"), "# File panel")
      },
      async () => {
        const result = await WorkspaceFileSearch.search({ kind: "files", query: "file panel", limit: 5 })
        expect(result.kind).toBe("files")
        expect(result.truncated).toBe(false)

        const filePanel = result.items.find(
          (item) => item.kind === "file" && item.path === "src/components/file-panel.tsx",
        )
        expect(filePanel).toBeDefined()
        if (filePanel?.kind === "file") {
          expect(filePanel.type).toBe("file")
          expect(filePanel.indices.length).toBeGreaterThan(0)
          expect(filePanel.node?.type).toBe("file")
        }
      },
    )
  })

  test("keeps directories in file search and supports include/exclude filters", async () => {
    await withWorkspace(
      async (dir) => {
        await fs.mkdir(path.join(dir, "src", "components"), { recursive: true })
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await Bun.write(path.join(dir, "src", "components", "file-panel.tsx"), "export const FilePanel = 1")
        await Bun.write(path.join(dir, "docs", "file-panel.md"), "# File panel")
      },
      async () => {
        const result = await WorkspaceFileSearch.search({
          kind: "files",
          query: "components",
          include: "src/**",
          exclude: "**/*.md",
          limit: 10,
        })
        expect(result.items.some((item) => item.kind === "file" && item.type === "directory")).toBe(true)
        expect(result.items.some((item) => item.kind === "file" && item.path.endsWith(".md"))).toBe(false)
      },
    )
  })

  test("parses ripgrep content matches with line and submatch columns", async () => {
    await withWorkspace(
      async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "src", "search.txt"), "alpha\nneedle one\nbeta needle two\n")
      },
      async () => {
        const result = await WorkspaceFileSearch.search({ kind: "content", query: "needle", limit: 1 })
        expect(result.kind).toBe("content")
        expect(result.items).toHaveLength(1)
        expect(result.truncated).toBe(true)
        expect(result.nextCursor).toBe("1")

        const match = result.items[0]
        expect(match?.kind).toBe("content")
        if (match?.kind === "content") {
          expect(match.path).toBe("src/search.txt")
          expect(match.lineNumber).toBe(2)
          expect(match.column).toBe(0)
          expect(match.line).toBe("needle one")
          expect(match.submatches[0]).toEqual({ text: "needle", start: 0, end: 6 })
          expect(match.previewRanges[0]).toEqual({ start: 0, end: 6 })
        }

        const next = await WorkspaceFileSearch.search({
          kind: "content",
          query: "needle",
          limit: 1,
          cursor: result.nextCursor,
        })
        expect(next.items).toHaveLength(1)
        expect(next.items[0]).toMatchObject({ kind: "content", path: "src/search.txt", lineNumber: 3 })
        expect(next.truncated).toBe(false)
      },
    )
  })

  test("bounds the displayed content line while preserving match metadata", async () => {
    await withWorkspace(
      async (dir) => {
        await Bun.write(path.join(dir, "large.txt"), `needle ${"x".repeat(3000)}\n`)
      },
      async () => {
        const result = await WorkspaceFileSearch.search({ kind: "content", query: "needle", limit: 10 })
        const match = result.items[0]
        expect(match?.kind).toBe("content")
        if (match?.kind === "content") {
          expect(match.line.length).toBe(2003)
          expect(match.submatches[0]).toEqual({ text: "needle", start: 0, end: 6 })
        }
      },
    )
  })

  test("returns an empty content search result without pretending capability failure", async () => {
    await withWorkspace(
      async (dir) => {
        await Bun.write(path.join(dir, "src.txt"), "alpha\nbeta\n")
      },
      async () => {
        const result = await WorkspaceFileSearch.search({ kind: "content", query: "missing", limit: 10 })
        expect(result.kind).toBe("content")
        expect(result.items).toEqual([])
        expect(result.truncated).toBe(false)
        expect(result.capability).toBeUndefined()
      },
    )
  })

  test("does not offer a cursor when the subprocess output safety limit stops content search", async () => {
    await withWorkspace(
      async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "needle small\n")
        await Bun.write(path.join(dir, "z.txt"), `needle ${"x".repeat(300_000)}\n`)
      },
      async () => {
        const result = await WorkspaceFileSearch.search({ kind: "content", query: "needle", limit: 10 })
        expect(result.items).toHaveLength(1)
        expect(result.truncated).toBe(true)
        expect(result.nextCursor).toBeUndefined()
      },
    )
  })

  test.skipIf(process.platform === "win32")(
    "content search aborts and returns when the search process ignores SIGTERM",
    async () => {
      await using hang = await tmpdir({
        init: async (dir) => {
          const script = path.join(dir, "hang-rg.sh")
          await Bun.write(
            script,
            `#!/bin/sh
trap '' TERM
# Busy-loop in the shell itself so SIGKILL targets the same process that owns stdout.
# Response/stream consumers would hang forever if the process is not hard-killed.
while true; do :; done
`,
          )
          await fs.chmod(script, 0o755)
        },
      })

      const hangScript = path.join(hang.path, "hang-rg.sh")
      const originalFilepath = Ripgrep.filepath
      ;(Ripgrep as any).filepath = async () => hangScript

      try {
        await withWorkspace(
          async (dir) => {
            await Bun.write(path.join(dir, "src.txt"), "needle\n")
          },
          async () => {
            const controller = new AbortController()
            const search = WorkspaceFileSearch.search({
              kind: "content",
              query: "needle",
              limit: 10,
              signal: controller.signal,
            })

            setTimeout(() => controller.abort(), 50)
            const started = Date.now()
            await expect(search).rejects.toMatchObject({ name: "AbortError" })
            expect(Date.now() - started).toBeLessThan(5_000)
          },
        )
      } finally {
        ;(Ripgrep as any).filepath = originalFilepath
      }
    },
  )

  test("reports symbol search unavailable when no LSP client is active", async () => {
    await withWorkspace(
      async (dir) => {
        await Bun.write(path.join(dir, "src.ts"), "export const value = 1")
      },
      async () => {
        const originalStatus = LSP.status
        const originalWorkspaceSymbol = LSP.workspaceSymbol
        ;(LSP as any).status = async () => []
        ;(LSP as any).workspaceSymbol = async () => {
          throw new Error("should not be called")
        }
        try {
          const result = await WorkspaceFileSearch.search({ kind: "symbol", query: "value", limit: 10 })
          expect(result.kind).toBe("symbol")
          expect(result.items).toEqual([])
          expect(result.capability?.available).toBe(false)
          expect(result.capability?.reason).toContain("No active LSP")
        } finally {
          ;(LSP as any).status = originalStatus
          ;(LSP as any).workspaceSymbol = originalWorkspaceSymbol
        }
      },
    )
  })

  test("returns workspace symbols when LSP is available", async () => {
    await withWorkspace(
      async (dir) => {
        await Bun.write(path.join(dir, "src.ts"), "export const value = 1")
      },
      async (dir) => {
        const originalStatus = LSP.status
        const originalWorkspaceSymbol = LSP.workspaceSymbol
        ;(LSP as any).status = async () => [{ id: "test", name: "test", root: "", status: "connected" }]
        ;(LSP as any).workspaceSymbol = async () => [
          {
            name: "value",
            kind: 13,
            location: {
              uri: pathToFileURL(path.join(dir, "src.ts")).href,
              range: {
                start: { line: 0, character: 13 },
                end: { line: 0, character: 18 },
              },
            },
          },
        ]
        try {
          const result = await WorkspaceFileSearch.search({ kind: "symbol", query: "value", limit: 10 })
          expect(result.kind).toBe("symbol")
          expect(result.capability?.available).toBe(true)
          expect(result.items[0]?.kind).toBe("symbol")
          const symbol = result.items[0]
          if (symbol?.kind === "symbol") {
            expect(symbol.name).toBe("value")
            expect(symbol.path).toBe("src.ts")
          }
        } finally {
          ;(LSP as any).status = originalStatus
          ;(LSP as any).workspaceSymbol = originalWorkspaceSymbol
        }
      },
    )
  })

  test("applies watcher-style index add, delete, and rename updates incrementally", async () => {
    await withWorkspace(
      async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "src", "old.ts"), "export const oldName = 1")
      },
      async (dir) => {
        await WorkspaceFileIndexer.snapshot({ force: true })

        await Bun.write(path.join(dir, "src", "added.ts"), "export const addedName = 1")
        await WorkspaceFileIndexer.applyChange({ path: "src/added.ts", event: "add" })
        let result = await WorkspaceFileSearch.search({ kind: "files", query: "added", limit: 10 })
        expect(result.items.some((item) => item.kind === "file" && item.path === "src/added.ts")).toBe(true)

        await fs.rename(path.join(dir, "src", "old.ts"), path.join(dir, "src", "new.ts"))
        await WorkspaceFileIndexer.applyRename({ from: "src/old.ts", to: "src/new.ts" })
        result = await WorkspaceFileSearch.search({ kind: "files", query: "new", limit: 10 })
        expect(result.items.some((item) => item.kind === "file" && item.path === "src/new.ts")).toBe(true)
        result = await WorkspaceFileSearch.search({ kind: "files", query: "old", limit: 10 })
        expect(result.items.some((item) => item.kind === "file" && item.path === "src/old.ts")).toBe(false)

        await fs.rm(path.join(dir, "src", "added.ts"))
        await WorkspaceFileIndexer.applyChange({ path: "src/added.ts", event: "unlink" })
        result = await WorkspaceFileSearch.search({ kind: "files", query: "added", limit: 10 })
        expect(result.items.some((item) => item.kind === "file" && item.path === "src/added.ts")).toBe(false)
      },
    )
  })

  test("applies watcher batches without resolving git status", async () => {
    await withWorkspace(
      async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
      },
      async (dir) => {
        const originalStatusForPath = WorkspaceFileStatus.statusForPath
        let statusCalls = 0
        WorkspaceFileStatus.statusForPath = async () => {
          statusCalls += 1
          return undefined
        }
        try {
          await Bun.write(path.join(dir, "src", "added.ts"), "export const added = true")
          const nodes = await WorkspaceFileIndexer.applyChanges([{ path: "src/added.ts", event: "add" }])
          expect(nodes.get("src/added.ts")?.path).toBe("src/added.ts")
          expect(nodes.get("src/added.ts")?.gitStatus).toBeUndefined()
          expect(statusCalls).toBe(0)
        } finally {
          WorkspaceFileStatus.statusForPath = originalStatusForPath
        }
      },
    )
  })
})
