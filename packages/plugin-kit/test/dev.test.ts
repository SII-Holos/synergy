import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { publishGeneration } from "../src/commands/dev"
import { createFixtureProject, writeMinimalPlugin } from "./fixtures"

function generationSource(version: string, description: string) {
  return `import { definePlugin } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "dev-generation",
  version: "${version}",
  description: "${description}",
  contributions: [],
})
`
}

describe("publishGeneration", () => {
  test("cleans the staging directory when the build fails", async () => {
    const project = createFixtureProject("dev-failure-")
    try {
      writeMinimalPlugin(project, "export default @")
      expect(await publishGeneration(project.root)).toBe(false)
      const devRoot = path.join(project.root, "dist", "dev")
      if (fs.existsSync(devRoot)) {
        const staging = fs
          .readdirSync(devRoot, { withFileTypes: true })
          .filter((entry) => entry.name.startsWith(".staging-"))
        expect(staging).toEqual([])
      }
    } finally {
      project.cleanup()
    }
  })

  test("publishes generations, reuses identical generations, and prunes old ones", async () => {
    const project = createFixtureProject("dev-generations-")
    try {
      writeMinimalPlugin(project, generationSource("1.0.0", "first"))
      expect(await publishGeneration(project.root)).toBe(true)

      const devRoot = path.join(project.root, "dist", "dev")
      const pointer = JSON.parse(fs.readFileSync(path.join(devRoot, "current.json"), "utf8"))
      expect(pointer.pluginId).toBe("dev-generation")
      expect(fs.existsSync(pointer.directory)).toBe(true)
      expect(pointer.directory).toContain(path.join("dist", "dev"))

      expect(await publishGeneration(project.root)).toBe(true)
      const directories = fs
        .readdirSync(devRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
      expect(directories).toHaveLength(1)

      project.writeFile("src/index.ts", generationSource("1.0.1", "second"))
      expect(await publishGeneration(project.root)).toBe(true)
      project.writeFile("src/index.ts", generationSource("1.0.2", "third"))
      expect(await publishGeneration(project.root)).toBe(true)
      project.writeFile("src/index.ts", generationSource("1.0.3", "fourth"))
      expect(await publishGeneration(project.root)).toBe(true)

      const remaining = fs
        .readdirSync(devRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".staging-"))
      expect(remaining.length).toBe(3)
    } finally {
      project.cleanup()
    }
  })

  test("requires an explicit SYNERGY_HOME for live reload", async () => {
    const project = createFixtureProject("dev-reload-home-")
    const previous = process.env.SYNERGY_HOME
    try {
      writeMinimalPlugin(project, generationSource("1.0.0", "reload"))
      delete process.env.SYNERGY_HOME
      await expect(publishGeneration(project.root, "http://127.0.0.1:9")).rejects.toThrow(
        /Live reload requires an explicit isolated SYNERGY_HOME/,
      )
    } finally {
      if (previous === undefined) delete process.env.SYNERGY_HOME
      else process.env.SYNERGY_HOME = previous
      project.cleanup()
    }
  })

  test("posts the generation to the dev server and reports failures", async () => {
    const project = createFixtureProject("dev-reload-server-")
    const previous = process.env.SYNERGY_HOME
    try {
      writeMinimalPlugin(project, generationSource("1.0.0", "reload"))
      const received: unknown[] = []
      const server = Bun.serve({
        port: 0,
        fetch(request, server) {
          if (request.method === "POST" && new URL(request.url).pathname === "/plugin/dev/reload") {
            received.push(server)
            return new Response("ok")
          }
          return new Response("not found", { status: 404 })
        },
      })
      process.env.SYNERGY_HOME = project.root

      expect(await publishGeneration(project.root, server.url.href)).toBe(true)
      expect(received).toHaveLength(1)

      server.stop()

      const failing = Bun.serve({
        port: 0,
        fetch: () => new Response("rejected", { status: 500 }),
      })
      await expect(publishGeneration(project.root, failing.url.href)).rejects.toThrow(
        /Synergy dev reload failed: 500 rejected/,
      )
      failing.stop()
    } finally {
      if (previous === undefined) delete process.env.SYNERGY_HOME
      else process.env.SYNERGY_HOME = previous
      project.cleanup()
    }
  })
})
