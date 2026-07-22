import { describe, expect, test, mock } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js"
import { Global } from "../../src/global"
import { Plugin } from "../../src/plugin"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"
import { Skill } from "../../src/skill"
import { SkillArchive } from "../../src/skill/archive"
import { tmpdir } from "../fixture/fixture"

const manifest = (name: string, extra = "") => `---
name: ${name}
description: ${name} description.
${extra}---

# ${name}
`

async function zip(entries: Array<{ name: string; content: string }>) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const entry of entries) await writer.add(entry.name, new TextReader(entry.content))
  return writer.close()
}

async function zipNames(bytes: Uint8Array) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false })
  try {
    return (await reader.getEntries()).map((entry) => entry.filename)
  } finally {
    await reader.close()
  }
}

function scopedUrl(directory: string, value: string) {
  return `${value}${value.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`
}

async function importFile(input: {
  app: ReturnType<typeof Server.App>
  directory: string
  filename: string
  bytes: Uint8Array
  scope?: "project" | "global"
}) {
  const body = new FormData()
  body.set("file", new File([new Uint8Array(input.bytes).buffer], input.filename, { type: "application/zip" }))
  if (input.scope) body.set("scope", input.scope)
  return input.app.request(scopedUrl(input.directory, "/skill/import"), { method: "POST", body })
}

describe.serial("skill route", () => {
  test("lists domain-owned public summaries and diagnostics", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, ".synergy", "skill", "valid-skill", "SKILL.md"), manifest("valid-skill"))
        await Bun.write(
          path.join(dir, ".synergy", "skill", "broken-skill", "SKILL.md"),
          `---
name: broken-skill
description: bad: yaml: here
---
`,
        )
      },
    })

    const response = await Server.App().request(scopedUrl(tmp.path, "/skill"), { method: "GET" })
    expect(response.status).toBe(200)
    const data = await response.json()
    const skill = data.items.find((item: { name: string }) => item.name === "valid-skill")
    expect(skill).toMatchObject({
      source: "synergy",
      scope: "project",
      invocation: { user: true, model: true },
      exportable: true,
      diagnostics: [],
    })
    expect(data.items.some((item: { name: string }) => item.name === "broken-skill")).toBe(false)
    expect(data.diagnostics.some((item: { name: string }) => item.name === "broken-skill")).toBe(true)
  })

  test("lists plugin metadata as non-exportable and prevents deletion", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalSkillEntries = Plugin.skillEntries
    ;(Plugin as typeof Plugin & { skillEntries: typeof Plugin.skillEntries }).skillEntries = mock(async () => [
      {
        name: "plugin-route-skill",
        description: "Plugin route skill.",
        content: "# Plugin Route Skill",
        references: { "references/guide.md": "# Guide" },
        pluginId: "route-plugin",
        contributionId: "plugin-route-skill",
        pluginName: "Route Plugin",
        pluginDir: path.join(tmp.path, "route-plugin"),
      },
    ])

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Skill.reload()
          const app = Server.App()
          const response = await app.request(scopedUrl(tmp.path, "/skill"), { method: "GET" })
          const data = await response.json()
          const summary = data.items.find((item: { name: string }) => item.name === "plugin-route-skill")
          expect(summary).toMatchObject({
            source: "plugin",
            scope: "external",
            pluginId: "route-plugin",
            exportable: false,
          })
          expect(summary).not.toHaveProperty("references")

          const exportResponse = await app.request(scopedUrl(tmp.path, "/skill/plugin-route-skill/export"))
          expect(exportResponse.status).toBe(400)
          expect(await exportResponse.json()).toMatchObject({
            name: "SkillExportUnavailableError",
            data: { code: "skill.export_unavailable" },
          })

          const deleteResponse = await app.request(scopedUrl(tmp.path, "/skill/plugin-route-skill"), {
            method: "DELETE",
          })
          expect(deleteResponse.status).toBe(400)
          expect(await deleteResponse.json()).toMatchObject({ error: "Cannot delete plugin skills" })
        },
      })
    } finally {
      ;(Plugin as typeof Plugin & { skillEntries: typeof Plugin.skillEntries }).skillEntries = originalSkillEntries
      await ScopeContext.provide({ scope: await tmp.scope(), fn: () => Skill.reload() })
    }
  })

  test("refuses to delete a symlinked Skill whose canonical backing is outside trusted roots", async () => {
    await using tmp = await tmpdir({ git: true })
    const target = path.join(tmp.path, "external", "linked-delete")
    await Bun.write(path.join(target, "SKILL.md"), manifest("linked-delete"))
    await fs.mkdir(path.join(tmp.path, ".synergy", "skill"), { recursive: true })
    await fs.symlink(target, path.join(tmp.path, ".synergy", "skill", "linked-delete"), "dir")

    const response = await Server.App().request(scopedUrl(tmp.path, "/skill/linked-delete"), { method: "DELETE" })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: "Cannot delete a Skill outside trusted Skill roots",
      name: "linked-delete",
    })
    expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(true)
  })

  test.each([
    { scope: "project" as const, name: "project-import", filename: "project-import.skill" },
    { scope: "global" as const, name: "global-import", filename: "global-import.zip" },
  ])("imports a $scope Skill into the registry-backed destination", async ({ scope, name, filename }) => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()
    const response = await importFile({
      app,
      directory: tmp.path,
      filename,
      bytes: await zip([{ name: `${name}/SKILL.md`, content: manifest(name) }]),
      scope,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, name, scope })

    const destination =
      scope === "project"
        ? path.join(tmp.path, ".synergy", "skill", name, "SKILL.md")
        : path.join(Global.Path.config, "skill", name, "SKILL.md")
    expect(await Bun.file(destination).exists()).toBe(true)

    await fs.rm(path.dirname(destination), { recursive: true, force: true })
    await ScopeContext.provide({ scope: await tmp.scope(), fn: () => Skill.reload() })
  })

  test("reuses an existing plural project Skill root for imports", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.mkdir(path.join(tmp.path, ".synergy", "skills"), { recursive: true })
    const response = await importFile({
      app: Server.App(),
      directory: tmp.path,
      filename: "plural-root.zip",
      bytes: await zip([{ name: "plural-root/SKILL.md", content: manifest("plural-root") }]),
      scope: "project",
    })

    expect(response.status).toBe(200)
    expect(await Bun.file(path.join(tmp.path, ".synergy", "skills", "plural-root", "SKILL.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(tmp.path, ".synergy", "skill", "plural-root", "SKILL.md")).exists()).toBe(false)
  })

  test("returns structured attack, extension, conflict, and request-limit errors", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()

    const traversal = await importFile({
      app,
      directory: tmp.path,
      filename: "attack.zip",
      bytes: await zip([
        { name: "../escape.txt", content: "escape" },
        { name: "SKILL.md", content: manifest("attack-skill") },
      ]),
      scope: "project",
    })
    expect(traversal.status).toBe(400)
    expect(await traversal.json()).toMatchObject({
      name: "SkillArchiveInvalidError",
      data: { code: "skill.archive_path_invalid" },
    })
    expect(await Bun.file(path.join(tmp.path, ".synergy", "skill", "escape.txt")).exists()).toBe(false)

    const invalidExtension = await importFile({
      app,
      directory: tmp.path,
      filename: "skill.txt",
      bytes: await zip([{ name: "SKILL.md", content: manifest("extension-skill") }]),
      scope: "project",
    })
    expect(invalidExtension.status).toBe(400)
    expect(await invalidExtension.json()).toMatchObject({ data: { code: "skill.archive_extension_invalid" } })

    const bytes = await zip([{ name: "SKILL.md", content: manifest("conflict-route") }])
    expect(
      (await importFile({ app, directory: tmp.path, filename: "conflict.zip", bytes, scope: "project" })).status,
    ).toBe(200)
    const conflict = await importFile({ app, directory: tmp.path, filename: "conflict.zip", bytes, scope: "project" })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      name: "SkillArchiveConflictError",
      data: { code: "skill.archive_conflict", name: "conflict-route" },
    })

    const oversized = await app.request(scopedUrl(tmp.path, "/skill/import"), {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(SkillArchive.Policy.maxRequestBytes + 1),
      },
      body: "x",
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({
      name: "SkillArchiveLimitError",
      data: { code: "skill.archive_request_size_limit", limit: SkillArchive.Policy.maxRequestBytes },
    })
  })

  test("keeps URL import transport bounded and local-testable", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalFetch = globalThis.fetch
    const bytes = await zip([{ name: "SKILL.md", content: manifest("url-import") }])
    globalThis.fetch = mock(
      async () => new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }),
    ) as unknown as typeof fetch
    try {
      const response = await Server.App().request(scopedUrl(tmp.path, "/skill/import-url"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.invalid/url-import.skill", scope: "project" }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true, name: "url-import", scope: "project" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("follows bounded URL redirects before importing an archive", async () => {
    await using tmp = await tmpdir({ git: true })
    const bytes = await zip([{ name: "SKILL.md", content: manifest("redirect-import") }])
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/redirect-import.skill") {
          return Response.redirect(`${url.origin}/redirected/redirect-import.skill`, 302)
        }
        return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } })
      },
    })

    const response = await Server.App().request(scopedUrl(tmp.path, "/skill/import-url"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://127.0.0.1:${server.port}/redirect-import.skill`,
        scope: "project",
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, name: "redirect-import", scope: "project" })
  })

  test("exports ZIP and .skill aliases and completes import-export-delete-import round trip", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.App()
    const name = "roundtrip-skill"
    const original = manifest(name, "compatibility: Requires git.\n")
    const imported = await importFile({
      app,
      directory: tmp.path,
      filename: `${name}.zip`,
      bytes: await zip([
        { name: `${name}/SKILL.md`, content: original },
        { name: `${name}/references/guide.txt`, content: "guide bytes\n" },
      ]),
      scope: "project",
    })
    expect(imported.status).toBe(200)

    const exported = await app.request(scopedUrl(tmp.path, `/skill/${name}/export`))
    expect(exported.status).toBe(200)
    expect(exported.headers.get("content-type")).toContain("application/zip")
    expect(exported.headers.get("content-disposition")).toBe(`attachment; filename="${name}.zip"`)
    const exportedBytes = new Uint8Array(await exported.arrayBuffer())
    expect(await zipNames(exportedBytes)).toEqual([
      `${name}/`,
      `${name}/references/`,
      `${name}/references/guide.txt`,
      `${name}/SKILL.md`,
    ])

    const alias = await app.request(scopedUrl(tmp.path, `/skill/${name}/export?format=skill`))
    expect(alias.status).toBe(200)
    expect(alias.headers.get("content-disposition")).toBe(`attachment; filename="${name}.skill"`)
    expect(await zipNames(new Uint8Array(await alias.arrayBuffer()))).toEqual(await zipNames(exportedBytes))

    expect((await app.request(scopedUrl(tmp.path, `/skill/${name}`), { method: "DELETE" })).status).toBe(200)
    const reimported = await importFile({
      app,
      directory: tmp.path,
      filename: `${name}.zip`,
      bytes: exportedBytes,
      scope: "project",
    })
    expect(reimported.status).toBe(200)
    expect(await Bun.file(path.join(tmp.path, ".synergy", "skill", name, "SKILL.md")).text()).toBe(original)
  })

  test("rejects lenient-only vendor and builtin exports with stable domain errors", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".claude", "skills", "vendor-only", "SKILL.md"),
          manifest("vendor-only", "vendor-field: true\n"),
        )
      },
    })
    const app = Server.App()

    const vendor = await app.request(scopedUrl(tmp.path, "/skill/vendor-only/export"))
    expect(vendor.status).toBe(400)
    expect(await vendor.json()).toMatchObject({
      name: "SkillExportNotStandardError",
      data: { code: "skill.export_not_standard", name: "vendor-only" },
    })

    const builtin = await app.request(scopedUrl(tmp.path, "/skill/synergy-config/export"))
    expect(builtin.status).toBe(400)
    expect(await builtin.json()).toMatchObject({
      name: "SkillExportUnavailableError",
      data: { code: "skill.export_unavailable", name: "synergy-config" },
    })
  })
})
