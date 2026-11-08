import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { openOrganizationService } from "../src/service"
import { commands } from "../src/cli-adapter"

const fixture = path.join(import.meta.dir, "fixtures/cli.mjs")
function spawn(env: Record<string, string | undefined>, args: string[]) {
  return Bun.spawn([process.execPath, fixture, "org", ...args], {
    env: { ...env, SYNERGY_RUNTIME_ROOT: undefined },
    stdout: "pipe",
    stderr: "pipe",
  })
}
async function invoke(env: Record<string, string | undefined>, args: string[]) {
  const child = spawn(env, args)
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

test("organization CLI help is available without a Home and writes require an explicit absolute Home", async () => {
  const isolated = await createIsolatedTestEnv()
  try {
    const help = await invoke(isolated.env, ["--help"])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("init")
    expect(help.stdout).toContain("serve")
    const output = path.join(isolated.env.SYNERGY_TEST_ROOT!, "bootstrap.json")
    const missing = await invoke(isolated.env, ["init", "--output", output])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("SYNERGY_HOME")
    expect(await fs.readdir(isolated.env.SYNERGY_TEST_HOME!, { recursive: true })).toEqual([])
    expect(await Bun.file(output).exists()).toBe(false)
    const relative = await invoke({ ...isolated.env, SYNERGY_HOME: "relative-home" }, ["init", "--output", output])
    expect(relative.code).toBe(1)
    expect(relative.stderr).toContain("absolute")
    for (const args of [
      ["serve", "--origin", "http://organization.example", "--port", "4080"],
      ["serve", "--origin", "https://organization.example", "--port", "65536"],
      ["init", "--output", "relative.json"],
    ]) {
      expect((await invoke({ ...isolated.env, SYNERGY_HOME: isolated.env.SYNERGY_TEST_HOME }, args)).code).toBe(1)
    }
    expect(await fs.readdir(isolated.env.SYNERGY_TEST_HOME!, { recursive: true })).toEqual([])
  } finally {
    await isolated.dispose()
  }
})

test("init keeps its single-use secret in a private file and refuses to overwrite it", async () => {
  const isolated = await createIsolatedTestEnv()
  const env = { ...isolated.env, SYNERGY_HOME: isolated.env.SYNERGY_TEST_HOME }
  const output = path.join(isolated.env.SYNERGY_TEST_ROOT!, "bootstrap.json")
  try {
    await commands[0].load()
    const { OrganizationInitCommand } = await import("../src/cli/organization")
    const home = process.env.SYNERGY_HOME
    const root = process.env.SYNERGY_RUNTIME_ROOT
    const log = console.log
    const printed: string[] = []
    try {
      process.env.SYNERGY_HOME = env.SYNERGY_HOME
      delete process.env.SYNERGY_RUNTIME_ROOT
      console.log = (line) => printed.push(String(line))
      if (typeof OrganizationInitCommand.handler !== "function") throw new Error("Initialization handler is missing")
      await OrganizationInitCommand.handler({ output, _: ["org", "init"], $0: "synergy" })
    } finally {
      console.log = log
      if (home === undefined) delete process.env.SYNERGY_HOME
      else process.env.SYNERGY_HOME = home
      if (root === undefined) delete process.env.SYNERGY_RUNTIME_ROOT
      else process.env.SYNERGY_RUNTIME_ROOT = root
    }
    const result = { stdout: printed.join("\n"), stderr: "" }
    const secret = await Bun.file(output).json()
    expect(secret.token).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: true, output, orgID: secret.orgID })
    expect(result.stdout + result.stderr).not.toContain(secret.token)
    expect(await fs.readdir(path.join(env.SYNERGY_HOME!, ".synergy"))).not.toContain("config")
    if (process.platform !== "win32") expect((await fs.stat(output)).mode & 0o777).toBe(0o600)
    const duplicate = await invoke(env, ["init", "--output", output])
    expect(duplicate.code).toBe(1)
    expect(await Bun.file(output).json()).toEqual(secret)
    const other = path.join(isolated.env.SYNERGY_TEST_ROOT!, "other-bootstrap.json")
    expect(
      (
        await invoke({ ...env, SYNERGY_HOME: path.join(isolated.env.SYNERGY_TEST_ROOT!, "other-home") }, [
          "init",
          "--output",
          other,
        ])
      ).code,
    ).toBe(0)
    expect((await Bun.file(other).json()).orgID).not.toBe(secret.orgID)
    const origin = "https://organization.example"
    await using service = await openOrganizationService({ home: env.SYNERGY_HOME!, publicOrigin: origin })
    const accepted = await service.fetch(
      new Request(`${origin}/org/v1/setup/bootstrap`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          token: secret.token,
          requestID: crypto.randomUUID(),
          organizationName: "CLI",
          loginName: "owner",
          displayName: "Owner",
          password: "a long command password",
        }),
      }),
    )
    expect(accepted.status).toBe(200)
    await service.close()
    const afterSetup = path.join(isolated.env.SYNERGY_TEST_ROOT!, "after-setup.json")
    expect((await invoke(env, ["init", "--output", afterSetup])).code).toBe(1)
    expect(await Bun.file(afterSetup).exists()).toBe(false)
  } finally {
    await isolated.dispose()
  }
})

test("invalid organization domain configuration stops CLI startup without exposing input or creating service data", async () => {
  const isolated = await createIsolatedTestEnv()
  const env = { ...isolated.env, SYNERGY_HOME: isolated.env.SYNERGY_TEST_HOME }
  const filename = path.join(env.SYNERGY_HOME!, ".synergy/config/synergy.d/150-organization.jsonc")
  const output = path.join(isolated.env.SYNERGY_TEST_ROOT!, "uncreated-token.json")
  try {
    await fs.mkdir(path.dirname(filename), { recursive: true })
    const secret = "synthetic-private-configuration"
    const contents = JSON.stringify({ organization: { unsupported: secret } })
    await Bun.write(filename, contents)
    for (const args of [
      ["init", "--output", output],
      ["serve", "--origin", "https://organization.example", "--port", "0"],
    ]) {
      const result = await invoke(env, args)
      expect(result.code).toBe(1)
      expect(result.stdout + result.stderr).not.toContain(secret)
    }
    expect(await Bun.file(output).exists()).toBe(false)
    await expect(fs.access(path.join(env.SYNERGY_HOME!, ".synergy/data"))).rejects.toThrow()
    expect(await Bun.file(filename).text()).toBe(contents)
  } finally {
    await isolated.dispose()
  }
})

test("serve owns only its listener and Home, refuses competing owners, and releases both on SIGTERM", async () => {
  const isolated = await createIsolatedTestEnv()
  const env = {
    ...isolated.env,
    SYNERGY_HOME: isolated.env.SYNERGY_TEST_HOME,
    SYNERGY_CONFIG_CONTENT: "invalid ambient configuration",
  }
  const configuration = path.join(env.SYNERGY_HOME!, ".synergy/config/synergy.d/150-organization.jsonc")
  await fs.mkdir(path.dirname(configuration), { recursive: true })
  await Bun.write(
    configuration,
    JSON.stringify({
      organization: {
        clientAuthentication: {
          clients: [{ clientID: "desktop", kind: "desktop", redirectUri: "synergy://organization-auth/callback" }],
        },
      },
    }),
  )
  const args = ["serve", "--origin", "https://organization.example", "--port", "0"]
  const child = spawn(env, args)
  const stderr = new Response(child.stderr).text()
  try {
    const reader = child.stdout.getReader()
    let output = ""
    while (!output.includes("\n")) {
      const next = await reader.read()
      if (next.done) throw new Error(`CLI exited before readiness: ${await stderr}`)
      output += new TextDecoder().decode(next.value)
    }
    reader.releaseLock()
    const ready = JSON.parse(output.split("\n")[0])
    expect(ready).toMatchObject({ ready: true, executesAgents: false })
    expect(await (await fetch(`${ready.url}org/v1/health`)).json()).toEqual({ ready: true, protocolVersion: 1 })
    expect((await fetch(`${ready.url}session`)).status).toBe(404)
    const discovery = await fetch(`${ready.url}org/v1/auth/discovery?clientID=desktop`)
    expect(discovery.status).toBe(200)
    expect(await discovery.json()).toMatchObject({
      orgID: ready.orgID,
      issuer: "https://organization.example",
      client: { clientID: "desktop" },
    })
    const competing = await invoke(env, args)
    expect(competing.code).toBe(1)
    expect(competing.stderr).toContain("already owns")
    const occupiedHome = path.join(isolated.env.SYNERGY_TEST_ROOT!, "occupied-port")
    const occupied = await invoke({ ...env, SYNERGY_HOME: occupiedHome }, [
      "serve",
      "--origin",
      "https://organization.example",
      "--port",
      new URL(ready.url).port,
    ])
    expect(occupied.code).toBe(1)
    await using failedListener = await openOrganizationService({ home: occupiedHome })
    expect((await failedListener.capabilities()).executesAgents).toBe(false)
    child.kill("SIGTERM")
    expect(await child.exited).toBe(0)
    expect(await stderr).not.toContain("Agent Runtime")
    await using reopened = await openOrganizationService({ home: env.SYNERGY_HOME! })
    expect((await reopened.deployment()).orgID).toBe(ready.orgID)
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM")
    await child.exited
    await isolated.dispose()
  }
}, 20000)
