import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Hono } from "hono"
import { ConfigRoute } from "../../src/server/config-route"

import { testRuntime } from "../support/runtime"

let runtime: Awaited<ReturnType<typeof testRuntime>>
beforeEach(async () => {
  runtime = await testRuntime()
})
afterEach(() => runtime.close())

function app() {
  return new Hono().route("/config", ConfigRoute())
}

function configPath(filename: "AGENTS.md" | "AGENTS.override.md") {
  return path.join(runtime.host.home, ".synergy", "config", filename)
}

async function writeInstruction(filename: "AGENTS.md" | "AGENTS.override.md", content: string) {
  const filepath = configPath(filename)
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, content)
}

describe.serial("global custom instructions route", () => {
  test("reads AGENTS.md until a managed override exists", () =>
    runtime.run(async () => {
      await writeInstruction("AGENTS.md", "Use concise answers.\n")

      const primaryResponse = await app().request("/config/instructions")
      expect(primaryResponse.status).toBe(200)
      expect(await primaryResponse.json()).toEqual({
        content: "Use concise answers.\n",
        source: "primary",
        sourceFilename: "AGENTS.md",
        editableFilename: "AGENTS.override.md",
        hasOverride: false,
        maxBytes: 32 * 1024,
      })

      await writeInstruction("AGENTS.override.md", "Reply in Chinese.\n")
      const overrideResponse = await app().request("/config/instructions")
      expect(overrideResponse.status).toBe(200)
      expect(await overrideResponse.json()).toMatchObject({
        content: "Reply in Chinese.\n",
        source: "override",
        sourceFilename: "AGENTS.override.md",
        hasOverride: true,
      })
    }))

  test("writes only AGENTS.override.md and returns the effective content", () =>
    runtime.run(async () => {
      await writeInstruction("AGENTS.md", "Base instructions.\n")

      const response = await app().request("/config/instructions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Personal instructions.\n" }),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        content: "Personal instructions.\n",
        source: "override",
        sourceFilename: "AGENTS.override.md",
        hasOverride: true,
      })
      expect(await Bun.file(configPath("AGENTS.md")).text()).toBe("Base instructions.\n")
      expect(await Bun.file(configPath("AGENTS.override.md")).text()).toBe("Personal instructions.\n")
    }))

  test("empty saves and reset remove the override and fall back to AGENTS.md", () =>
    runtime.run(async () => {
      await writeInstruction("AGENTS.md", "Base instructions.\n")
      await writeInstruction("AGENTS.override.md", "Temporary override.\n")

      const emptySave = await app().request("/config/instructions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "   \n" }),
      })
      expect(emptySave.status).toBe(200)
      expect(await emptySave.json()).toMatchObject({
        content: "Base instructions.\n",
        source: "primary",
        hasOverride: false,
      })
      expect(await Bun.file(configPath("AGENTS.override.md")).exists()).toBe(false)

      await writeInstruction("AGENTS.override.md", "Another override.\n")
      const reset = await app().request("/config/instructions", { method: "DELETE" })
      expect(reset.status).toBe(200)
      expect(await reset.json()).toMatchObject({
        content: "Base instructions.\n",
        source: "primary",
        hasOverride: false,
      })
      expect(await Bun.file(configPath("AGENTS.override.md")).exists()).toBe(false)
    }))

  test("rejects content larger than the instruction budget", () =>
    runtime.run(async () => {
      const response = await app().request("/config/instructions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "a".repeat(32 * 1024 + 1) }),
      })

      expect(response.status).toBe(400)
      expect(await Bun.file(configPath("AGENTS.override.md")).exists()).toBe(false)
    }))
})
