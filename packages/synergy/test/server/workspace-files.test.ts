import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

function workspaceUrl(endpoint: string, directory: string, params?: Record<string, string | number | boolean>) {
  const url = new URL(`http://synergy.test/workspace/files/${endpoint}`)
  url.searchParams.set("directory", directory)
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, String(value))
  }
  return url.pathname + url.search
}

function rawUrl(directory: string, rel: string): string {
  const token = Buffer.from(directory, "utf-8").toString("base64url")
  return `/workspace/files/raw/${token}/${rel}`
}

describe("GET /workspace/files", () => {
  test("requires a Scope instead of silently using home", async () => {
    const app = Server.App()
    const response = await app.request("/workspace/files/children")
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.name).toBe("ScopeRequired")
  })

  test("serves children, stat, read, search, and status through the unified route", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "src", "tracked.ts"), "export const tracked = 1\n")
      },
    })
    await $`git add src/tracked.ts`.cwd(tmp.path).quiet()
    await $`git commit -m baseline`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, "src", "tracked.ts"), "export const tracked = 2\n")
    await Bun.write(path.join(tmp.path, "src", "fresh.ts"), "export const fresh = 1\n")

    const app = Server.App()

    const children = await app.request(
      workspaceUrl("children", tmp.path, {
        path: "",
      }),
    )
    expect(children.status).toBe(200)
    const childrenBody = await children.json()
    expect(childrenBody.children.some((node: any) => node.path === "src")).toBe(true)

    const stat = await app.request(workspaceUrl("stat", tmp.path, { path: "src/tracked.ts" }))
    expect(stat.status).toBe(200)
    const statBody = await stat.json()
    expect(statBody.path).toBe("src/tracked.ts")
    expect(statBody.gitStatus).toBe("modified")

    const read = await app.request(workspaceUrl("read", tmp.path, { path: "src/tracked.ts", range: "0:1" }))
    expect(read.status).toBe(200)
    const readBody = await read.json()
    expect(readBody.kind).toBe("text")
    expect(readBody.content).toContain("tracked")

    const search = await app.request(workspaceUrl("search", tmp.path, { kind: "files", query: "fresh" }))
    expect(search.status).toBe(200)
    const searchBody = await search.json()
    expect(searchBody.items.some((item: any) => item.path === "src/fresh.ts")).toBe(true)

    const status = await app.request(workspaceUrl("status", tmp.path))
    expect(status.status).toBe(200)
    const statusBody = await status.json()
    expect(statusBody.files.find((file: any) => file.path === "src/tracked.ts")?.status).toBe("modified")
    expect(statusBody.files.find((file: any) => file.path === "src/fresh.ts")?.status).toBe("untracked")
  })

  test("does not keep compatibility routes for old /file and /find APIs", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()

    const file = await app.request(`/file?directory=${encodeURIComponent(tmp.path)}`)
    expect(file.status).toBe(404)

    const find = await app.request(`/find/file?directory=${encodeURIComponent(tmp.path)}&query=src`)
    expect(find.status).toBe(404)
  })

  test("returns a stable 404 when a persisted explorer directory no longer exists", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await Server.App().request(workspaceUrl("children", tmp.path, { path: "deleted/directory" }))

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.name).toBe("NotFoundError")
    expect(JSON.stringify(body)).not.toContain(tmp.path)
  })

  test("returns 403 instead of 500 when a directory symlink escapes the workspace", async () => {
    const sibling = path.join(os.tmpdir(), `synergy-test-sibling-${Date.now()}`)
    await fs.mkdir(sibling, { recursive: true })
    await Bun.write(path.join(sibling, "note.md"), "outside")
    let linkCreated = false
    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          try {
            await fs.symlink(sibling, path.join(dir, "docs"), "dir")
            linkCreated = true
          } catch (error) {
            const code = (error as { code?: unknown })?.code
            if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) throw error
          }
        },
      })
      if (!linkCreated) return
      const app = Server.App()

      const children = await app.request(workspaceUrl("children", tmp.path, { path: "docs" }))
      expect(children.status).toBe(403)
      const childrenBody = await children.json()
      expect(childrenBody.name).toBe("WorkspaceFileAccessDeniedError")
      expect(childrenBody.data.message).toContain("Access denied")

      const read = await app.request(workspaceUrl("read", tmp.path, { path: "docs/note.md" }))
      expect(read.status).toBe(403)
      const readBody = await read.json()
      expect(readBody.name).toBe("WorkspaceFileAccessDeniedError")

      const stat = await app.request(workspaceUrl("stat", tmp.path, { path: "docs/note.md" }))
      expect(stat.status).toBe(403)
    } finally {
      await fs.rm(sibling, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("serves children and read when the workspace root is a symlink", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await Bun.write(path.join(dir, "docs", "note.md"), "# note")
      },
    })
    const linkDir = path.join(os.tmpdir(), `synergy-test-root-link-${Math.random().toString(36).slice(2)}`)
    let linkCreated = false
    try {
      try {
        await fs.symlink(tmp.path, linkDir, "dir")
        linkCreated = true
      } catch (error) {
        const code = (error as { code?: unknown })?.code
        if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) throw error
      }
      if (!linkCreated) return
      const app = Server.App()

      const children = await app.request(workspaceUrl("children", linkDir, { path: "" }))
      expect(children.status).toBe(200)
      const childrenBody = await children.json()
      expect(childrenBody.children.some((node: any) => node.path === "docs")).toBe(true)

      const read = await app.request(workspaceUrl("read", linkDir, { path: "docs/note.md" }))
      expect(read.status).toBe(200)
      const readBody = await read.json()
      expect(readBody.kind).toBe("text")
    } finally {
      await fs.rm(linkDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe("POST /workspace/files/write", () => {
  function postWrite(app: ReturnType<typeof Server.App>, directory: string, body: Record<string, unknown>) {
    return app.request(workspaceUrl("write", directory), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  test("writes content to an existing file and returns the write result", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "hello.txt"), "original")
      },
    })
    const app = Server.App()

    const response = await postWrite(app, tmp.path, { path: "hello.txt", content: "updated content" })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.path).toBe("hello.txt")
    expect(body.existed).toBe(true)
    expect(body.size).toBe(Buffer.byteLength("updated content", "utf-8"))
    expect(typeof body.mtime).toBe("number")
    expect(body.mtime).toBeGreaterThan(0)
    expect(await Bun.file(path.join(tmp.path, "hello.txt")).text()).toBe("updated content")
  })

  test("allows overwriting without expectedMtime", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "notes.txt"), "first")
      },
    })
    const app = Server.App()

    const first = await postWrite(app, tmp.path, { path: "notes.txt", content: "second" })
    expect(first.status).toBe(200)
    const second = await postWrite(app, tmp.path, { path: "notes.txt", content: "third" })
    expect(second.status).toBe(200)
    expect(await Bun.file(path.join(tmp.path, "notes.txt")).text()).toBe("third")
  })

  test("succeeds when expectedMtime matches the on-disk mtime", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "edit.txt"), "before")
      },
    })
    const app = Server.App()

    const statResponse = await app.request(workspaceUrl("stat", tmp.path, { path: "edit.txt" }))
    expect(statResponse.status).toBe(200)
    const statBody = await statResponse.json()

    const response = await postWrite(app, tmp.path, {
      path: "edit.txt",
      content: "after",
      expectedMtime: statBody.mtime,
    })
    expect(response.status).toBe(200)
    expect(await Bun.file(path.join(tmp.path, "edit.txt")).text()).toBe("after")
  })

  test("rejects a stale expectedMtime with 409 and leaves the file untouched", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "conflict.txt"), "v1")
      },
    })
    const app = Server.App()

    const file = path.join(tmp.path, "conflict.txt")
    const staleMtime = (await fs.stat(file)).mtimeMs
    await Bun.sleep(25)
    await Bun.write(file, "v2")

    const response = await postWrite(app, tmp.path, {
      path: "conflict.txt",
      content: "v3",
      expectedMtime: staleMtime,
    })
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.name).toBe("WorkspaceFileWriteConflictError")
    expect(body.data.message).toContain("changed on disk")
    expect(await Bun.file(file).text()).toBe("v2")
  })

  test("skips the mtime conflict check with conflictPolicy overwrite", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "force.txt"), "v1")
      },
    })
    const app = Server.App()

    const file = path.join(tmp.path, "force.txt")
    const staleMtime = (await fs.stat(file)).mtimeMs
    await Bun.sleep(25)
    await Bun.write(file, "v2")

    const response = await postWrite(app, tmp.path, {
      path: "force.txt",
      content: "v3",
      expectedMtime: staleMtime,
      conflictPolicy: "overwrite",
    })
    expect(response.status).toBe(200)
    expect(await Bun.file(file).text()).toBe("v3")
  })

  test("returns 404 for a missing file", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await postWrite(Server.App(), tmp.path, { path: "missing.txt", content: "x" })
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.name).toBe("NotFoundError")
    expect(body.data.message).toContain("does not exist")
    expect(JSON.stringify(body)).not.toContain(tmp.path)
  })

  test("rejects paths escaping the workspace with 403", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()

    const relativeEscape = await postWrite(app, tmp.path, { path: "../outside.txt", content: "x" })
    expect(relativeEscape.status).toBe(403)
    const relativeBody = await relativeEscape.json()
    expect(relativeBody.name).toBe("WorkspaceFileAccessDeniedError")
    expect(relativeBody.data.message).toContain("Access denied")

    const absoluteEscape = await postWrite(app, tmp.path, {
      path: path.join(tmp.path, "..", "outside-absolute.txt"),
      content: "x",
    })
    expect(absoluteEscape.status).toBe(403)
    const absoluteBody = await absoluteEscape.json()
    expect(absoluteBody.name).toBe("WorkspaceFileAccessDeniedError")
    expect(absoluteBody.data.message).toContain("Access denied")
  })

  test("rejects sensitive paths like .env with 403", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, ".env"), "SECRET=1")
      },
    })
    const response = await postWrite(Server.App(), tmp.path, { path: ".env", content: "SECRET=2" })
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.name).toBe("WorkspaceFileAccessDeniedError")
    expect(body.data.message).toContain("Access denied")
    expect(await Bun.file(path.join(tmp.path, ".env")).text()).toBe("SECRET=1")
  })

  test("rejects a symlink pointing at a sensitive path with 403", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, ".env"), "SECRET=1")
        await fs.symlink(path.join(dir, ".env"), path.join(dir, "link.env"))
      },
    })
    const response = await postWrite(Server.App(), tmp.path, { path: "link.env", content: "SECRET=2" })
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.name).toBe("WorkspaceFileAccessDeniedError")
    expect(await Bun.file(path.join(tmp.path, ".env")).text()).toBe("SECRET=1")
  })

  test("rejects a directory target with 403", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "folder"), { recursive: true })
      },
    })
    const response = await postWrite(Server.App(), tmp.path, { path: "folder", content: "x" })
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.name).toBe("WorkspaceFileAccessDeniedError")
    expect(body.data.message).toContain("not a file")
  })

  test("rejects content larger than the write cap with 400", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "big.txt"), "small")
      },
    })
    const response = await postWrite(Server.App(), tmp.path, {
      path: "big.txt",
      content: "x".repeat(8 * 1024 * 1024 + 1),
    })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.name).toBe("WorkspaceFileTooLargeError")
    expect(await Bun.file(path.join(tmp.path, "big.txt")).text()).toBe("small")
  })

  test("rejects read-only files with 403", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "locked.txt"), "locked")
        await fs.chmod(path.join(dir, "locked.txt"), 0o444)
      },
    })
    const response = await postWrite(Server.App(), tmp.path, { path: "locked.txt", content: "unlocked?" })
    const body = await response.json()
    expect(body.name).toBe("WorkspaceFileAccessDeniedError")
    expect(body.data.message).toContain("read-only")
    expect(await Bun.file(path.join(tmp.path, "locked.txt")).text()).toBe("locked")
  })

  test("requires a Scope instead of silently using home", async () => {
    const response = await Server.App().request("/workspace/files/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "hello.txt", content: "x" }),
    })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.name).toBe("ScopeRequired")
  })
})
describe("GET /workspace/files/content", () => {
  test("requires a Scope instead of silently using home", async () => {
    const response = await Server.App().request("/workspace/files/content?path=guide.pdf")
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.name).toBe("ScopeRequired")
  })

  test("streams a PDF inside the workspace as application/pdf", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "guide.pdf"), "%PDF-1.1\n% fake body")
      },
    })
    const response = await Server.App().request(workspaceUrl("content", tmp.path, { path: "guide.pdf" }))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await response.text()
    expect(body.startsWith("%PDF")).toBe(true)
  })

  test("accepts a PDF with an uppercase extension", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "GUIDE.PDF"), "%PDF-1.1\n")
      },
    })
    const response = await Server.App().request(workspaceUrl("content", tmp.path, { path: "GUIDE.PDF" }))
    expect(response.status).toBe(200)
  })

  test("rejects content larger than the PDF preview cap with 400", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "huge.pdf"), "%PDF-1.1\n")
        await fs.truncate(path.join(dir, "huge.pdf"), 50 * 1024 * 1024 + 1)
      },
    })
    const response = await Server.App().request(workspaceUrl("content", tmp.path, { path: "huge.pdf" }))
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.name).toBe("WorkspaceFileTooLargeError")
  })

  test("rejects non-PDF files with 400", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "deck.pptx"), "fake pptx")
        await Bun.write(path.join(dir, "photo.png"), "fake png")
        await Bun.write(path.join(dir, "main.ts"), "export {}")
      },
    })
    const app = Server.App()
    for (const name of ["deck.pptx", "photo.png", "main.ts"]) {
      const response = await app.request(workspaceUrl("content", tmp.path, { path: name }))
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.name).toBe("WorkspaceFileUnsupportedPreviewError")
    }
  })

  test("rejects a path escaping the workspace with 403", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await Server.App().request(workspaceUrl("content", tmp.path, { path: "../outside.pdf" }))
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.name).toBe("WorkspaceFileAccessDeniedError")
  })

  test("rejects a symlink escaping the workspace with 403", async () => {
    const sibling = path.join(os.tmpdir(), `synergy-test-content-sibling-${Date.now()}`)
    await fs.mkdir(sibling, { recursive: true })
    await Bun.write(path.join(sibling, "secret.pdf"), "%PDF-1.1\n")
    let linkCreated = false
    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          try {
            await fs.symlink(sibling, path.join(dir, "docs"), "dir")
            linkCreated = true
          } catch (error) {
            const code = (error as { code?: unknown })?.code
            if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) throw error
          }
        },
      })
      if (!linkCreated) return
      const response = await Server.App().request(workspaceUrl("content", tmp.path, { path: "docs/secret.pdf" }))
      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.name).toBe("WorkspaceFileAccessDeniedError")
    } finally {
      await fs.rm(sibling, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("returns 404 for a missing file", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await Server.App().request(workspaceUrl("content", tmp.path, { path: "missing.pdf" }))
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.name).toBe("NotFoundError")
  })

  test("keeps the JSON read result for a PDF as binary metadata", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "guide.pdf"), "%PDF-1.1\n")
      },
    })
    const response = await Server.App().request(workspaceUrl("read", tmp.path, { path: "guide.pdf", mode: "document" }))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.kind).toBe("binary")
    expect(body.content).toBeUndefined()
  })

  test("serves raw HTML with a sandboxed opaque-origin CSP", async () => {
    const html = "<!doctype html><title>doc</title><script>1</script><p>hi</p>"
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "doc.html"), html)
      },
    })
    const response = await Server.App().request(rawUrl(tmp.path, "doc.html"))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms allow-popups allow-modals",
    )
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toBe(html)
  })

  test("accepts a raw .htm file", async () => {
    const html = "<!doctype html><p>htm</p>"
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "doc.htm"), html)
      },
    })
    const response = await Server.App().request(rawUrl(tmp.path, "doc.htm"))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms allow-popups allow-modals",
    )
    expect(await response.text()).toBe(html)
  })

  test("serves relative static resources with their real mime type and no sandbox CSP", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "assets", "cover"), { recursive: true })
        await Bun.write(path.join(dir, "assets", "cover", "image1.jpeg"), Uint8Array.from([0xff, 0xd8, 0xff]))
        await Bun.write(path.join(dir, "assets", "app.js"), "console.log(1)\n")
      },
    })
    const app = Server.App()

    const image = await app.request(rawUrl(tmp.path, "assets/cover/image1.jpeg"))
    expect(image.status).toBe(200)
    expect(image.headers.get("content-type")).toContain("image/jpeg")
    expect(image.headers.get("content-security-policy") ?? "").not.toContain("sandbox")
    expect(image.headers.get("cache-control")).toBe("no-store")
    const bytes = await image.arrayBuffer()
    expect(new Uint8Array(bytes)).toEqual(Uint8Array.from([0xff, 0xd8, 0xff]))

    const script = await app.request(rawUrl(tmp.path, "assets/app.js"))
    expect(script.status).toBe(200)
    expect(script.headers.get("content-type")).toContain("javascript")
    expect(script.headers.get("content-security-policy") ?? "").not.toContain("sandbox")
  })

  test("serves files from a nested subdirectory under the raw prefix", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "resources", "templates", "01-cover-main"), { recursive: true })
        await Bun.write(path.join(dir, "resources", "templates", "01-cover-main", "cover.html"), "<p>cover</p>")
      },
    })
    const response = await Server.App().request(rawUrl(tmp.path, "resources/templates/01-cover-main/cover.html"))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("<p>cover</p>")
  })

  test("rejects raw paths with traversal or absolute segments with 403", async () => {
    const secret = path.join(os.tmpdir(), `synergy-raw-secret-${Date.now()}.txt`)
    await Bun.write(secret, "secret")
    try {
      await using tmp = await tmpdir({ git: true })
      const app = Server.App()
      for (const rel of [
        `../../../../${path.basename(os.tmpdir())}/${path.basename(secret)}`,
        "../outside.txt",
        "nested/../../outside.txt",
        "..%2F..%2Foutside.txt",
      ]) {
        const response = await app.request(rawUrl(tmp.path, rel))
        // Layers may reject these differently: URL parsing collapses lexical ../
        // (404), encoded %2F trips malformed-path handling (400), surviving
        // segments hit the traversal guard (403). All block the escape.
        expect([400, 403, 404]).toContain(response.status)
        expect(await response.text()).not.toContain("secret")
      }
    } finally {
      await fs.rm(secret, { force: true }).catch(() => {})
    }
  })

  test("rejects a missing raw scope token directory with 404", async () => {
    const missing = path.join(os.tmpdir(), `synergy-raw-missing-${Date.now()}`)
    const response = await Server.App().request(rawUrl(missing, "index.html"))
    expect(response.status).toBe(404)
  })

  test("returns 404 for a missing raw HTML file", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await Server.App().request(rawUrl(tmp.path, "missing.html"))
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.name).toBe("NotFoundError")
  })
})
