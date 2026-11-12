import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

const installed = process.env.SYNERGY_TEST_ORGANIZATION_INSTALL
const entry = installed
  ? path.join(installed, "node_modules/.bin/synergy-org")
  : path.resolve(import.meta.dir, "../src/entry.ts")
const cwd = installed ?? path.resolve(import.meta.dir, "..")
async function invoke(env: Record<string, string | undefined>, args: string[]) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    cwd,
    env: { ...env, NODE_PATH: undefined, NODE_OPTIONS: undefined },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test("the independent entry keeps discovery and rejected input outside ambient configuration", async () => {
  const isolation = await createIsolatedTestEnv()
  try {
    const env = { ...isolation.env, SYNERGY_HOME: undefined, SYNERGY_RUNTIME_ROOT: undefined }
    const output = path.join(isolation.env.SYNERGY_TEST_ROOT!, "bootstrap.json")
    const help = await invoke(env, ["--help"])
    expect(help.code, help.stderr).toBe(0)
    expect(help.stdout).toContain("synergy-org init")
    expect(help.stdout).toContain("synergy-org serve")
    expect(help.stdout).not.toContain("send [message..]")
    const alias = await invoke(env, ["bootstrap", "--help"])
    expect(alias.code, alias.stderr).toBe(0)
    expect(alias.stdout).toContain("--output")
    for (const args of [["unknown"], ["init", "--output", output], ["serve", "--origin", "http://invalid"]]) {
      const rejected = await invoke(env, args)
      expect(rejected.code).toBe(1)
      expect(rejected.stderr).not.toContain("Agent Runtime must")
    }
    expect((await invoke({ ...env, SYNERGY_HOME: "relative" }, ["init", "--output", output])).code).toBe(1)
    expect(await Bun.file(output).exists()).toBe(false)
    expect(await fs.readdir(isolation.env.SYNERGY_TEST_HOME!, { recursive: true })).toEqual([])
  } finally {
    await isolation.dispose()
  }
})

test("the independent service ignores unrelated feature settings and preserves one deployment across real child restarts", async () => {
  const isolation = await createIsolatedTestEnv()
  const home = path.join(isolation.env.SYNERGY_TEST_ROOT!, "organization-home")
  const output = path.join(isolation.env.SYNERGY_TEST_ROOT!, "bootstrap.json")
  const feature = path.join(home, ".synergy", "config", "synergy.d", "140-features.jsonc")
  const env = { ...isolation.env, SYNERGY_HOME: home, SYNERGY_RUNTIME_ROOT: undefined }
  const secret = "FEATURE_SETTINGS_MUST_NOT_BE_READ"
  await Bun.write(feature, secret)
  try {
    const initialized = await invoke(env, ["init", "--output", output])
    expect(initialized.code, initialized.stderr).toBe(0)
    const bootstrap = await Bun.file(output).json()
    expect(initialized.stdout + initialized.stderr).not.toContain(bootstrap.token)
    expect(await Bun.file(feature).text()).toBe(secret)
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = Bun.spawn(
        [
          process.execPath,
          entry,
          "serve",
          "--origin",
          "https://organization.example",
          "--hostname",
          "127.0.0.1",
          "--port",
          "0",
        ],
        {
          cwd,
          env: { ...env, NODE_PATH: undefined, NODE_OPTIONS: undefined },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      let stopped = false
      try {
        const reader = child.stdout.getReader()
        let text = ""
        const deadline = setTimeout(() => {
          child.kill("SIGTERM")
        }, 15000)
        try {
          while (!text.includes("\n")) {
            const read = await reader.read()
            if (read.done) throw new Error("Independent service exited before readiness")
            text += new TextDecoder().decode(read.value)
          }
        } finally {
          clearTimeout(deadline)
          reader.releaseLock()
        }
        const ready = JSON.parse(text.trim())
        expect(ready).toMatchObject({ ready: true, executesAgents: false, orgID: bootstrap.orgID })
        const response = await fetch(new URL("/org/v1/health", ready.url))
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ready: true, protocolVersion: 1 })
        child.kill("SIGTERM")
        expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
        stopped = true
      } finally {
        if (!stopped) {
          child.kill("SIGTERM")
          await child.exited
        }
      }
    }
    expect(await fs.readdir(isolation.env.SYNERGY_TEST_HOME!, { recursive: true })).toEqual([])
    const rootFiles = await fs.readdir(path.join(home, ".synergy"))
    expect(rootFiles).not.toContain("cache")
    expect(rootFiles).not.toContain("logs")
    expect(await Bun.file(feature).text()).toBe(secret)
  } finally {
    await isolation.dispose()
  }
}, 45000)
