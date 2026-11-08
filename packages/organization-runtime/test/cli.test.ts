import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { prepareMemberHome } from "../src/home"
import { openMemberRuntime } from "../src/runtime"
import { fixture } from "./support/organization"
import { commands } from "../src/cli-adapter"

const entry = fileURLToPath(new URL("../../presets/src/index.ts", import.meta.url))

function spawn(env: Record<string, string | undefined>, args: string[], input: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-bunfig", entry, "member-runtime", ...args], {
    env,
    cwd: env.SYNERGY_TEST_HOME,
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 25_000,
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { child, output }
}

test("the member command has independent help and rejects missing or invalid launch input without ambient writes", async () => {
  const isolated = await createIsolatedTestEnv()
  try {
    const env = { ...isolated.env, SYNERGY_RUNTIME_ROOT: undefined, SYNERGY_HOME: undefined }
    expect(commands[0].initialization).toBe("owner")
    expect((await commands[0].load()).command).toBe("member-runtime")
    const help = spawn(env, ["--help"], "")
    expect(await help.child.exited).toBe(0)
    expect((await help.output)[0]).toContain("prepared member Runtime")
    for (const candidate of [env, { ...env, SYNERGY_HOME: "relative-home" }]) {
      const missing = spawn(candidate, [], "private-input-must-not-be-echoed")
      expect(await missing.child.exited).toBe(1)
      const output = (await missing.output).join("\n")
      expect(output).toContain("absolute")
      expect(output).not.toContain("private-input-must-not-be-echoed")
    }
    for (const input of ["invalid-private-input", JSON.stringify({ token: "private-input" }), " ".repeat(65537)]) {
      const invalid = spawn({ ...env, SYNERGY_HOME: isolated.env.SYNERGY_TEST_HOME }, [], input)
      expect(await invalid.child.exited).toBe(1)
      const output = (await invalid.output).join("\n")
      expect(output).toContain("supervisor request")
      expect(output).not.toContain("private-input")
    }
    expect(await fs.readdir(isolated.env.SYNERGY_TEST_HOME!, { recursive: true })).toEqual([])
  } finally {
    await isolated.dispose()
  }
}, 30_000)

test("a supervised member command enrolls from private input, serves its own Home and releases it on shutdown", async () => {
  await using service = await fixture()
  const member = await prepareMemberHome({
    baseDirectory: path.join(service.root, "members"),
    identity: service.identity,
    origin: service.origin,
  })
  const ticket = await service.ticket(member.identity.deviceID, member.publicKey)
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = listener.port!
  await listener.stop(true)
  const token = crypto.getRandomValues(new Uint8Array(32)).toHex()
  const request = {
    version: 1,
    identity: member.identity,
    deploymentIncarnation: ticket.runtime.deploymentIncarnation,
    port,
    token,
    ticket,
    ca: service.ca,
  }
  const supervisor = Bun.spawn(
    [process.execPath, "--no-env-file", "--no-bunfig", "-e", "await new Promise(() => {})"],
    { stdout: "ignore", stderr: "ignore", timeout: 25_000 },
  )
  const env = {
    ...process.env,
    SYNERGY_HOME: member.home,
    SYNERGY_RUNTIME_ROOT: member.root,
    SYNERGY_DESKTOP_PARENT_PID: String(supervisor.pid),
    SYNERGY_DESKTOP_STARTUP_PROGRESS: "1",
  }
  let runtimeID: string | undefined
  try {
    for (const restart of [false, true]) {
      const { child, output } = spawn(env, [], JSON.stringify({ ...request, ticket: restart ? undefined : ticket }))
      try {
        const client = createSynergyClient({
          baseUrl: `http://127.0.0.1:${port}`,
          headers: { authorization: `Bearer ${token}` },
        })
        const deadline = Date.now() + 15_000
        let ready = false
        while (!ready && child.exitCode === null && Date.now() < deadline) {
          ready = !!(await client.global.capabilities({ signal: AbortSignal.timeout(500) }).catch(() => undefined))
            ?.data?.runtimeID
          if (!ready) await Bun.sleep(25)
        }
        if (child.exitCode !== null) throw new Error((await output).join("\n"))
        expect(ready).toBe(true)
        const current = (await client.global.capabilities({ throwOnError: true })).data.runtimeID
        if (restart) {
          if (!runtimeID) throw new Error("The first member process did not provide an identity")
          expect(current).toBe(runtimeID)
        } else runtimeID = current
        expect((await fetch(`http://127.0.0.1:${port}/global/health`)).status).toBe(401)
        if (restart) {
          supervisor.kill("SIGTERM")
          await supervisor.exited
        } else child.kill("SIGTERM")
        expect(await child.exited).toBe(0)
        const printed = (await output).join("\n")
        expect(printed).not.toContain(token)
        expect(printed).not.toContain(ticket.token)
        expect(printed).toContain('"state":"ready"')
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
        await output
      }
    }
    if (!runtimeID) throw new Error("The member process did not provide an identity")
    const client = createSynergyClient({
      baseUrl: `http://127.0.0.1:${port}`,
      headers: { authorization: `Bearer ${token}` },
    })
    await using reopened = await openMemberRuntime({
      home: member.home,
      identity: member.identity,
      listen: { port, token },
    })
    expect((await client.global.capabilities({ throwOnError: true })).data.runtimeID).toBe(runtimeID)
  } finally {
    if (supervisor.exitCode === null) supervisor.kill("SIGKILL")
    await supervisor.exited
  }
}, 35_000)

test("a supervisor cannot silently enroll a different deployment into a prepared member Home", async () => {
  await using service = await fixture()
  const member = await prepareMemberHome({
    baseDirectory: path.join(service.root, "members"),
    identity: service.identity,
    origin: service.origin,
  })
  const ticket = await service.ticket(member.identity.deviceID, member.publicKey)
  const input = {
    version: 1,
    identity: member.identity,
    deploymentIncarnation: crypto.randomUUID(),
    port: 48000,
    token: "a".repeat(64),
    ticket,
    ca: service.ca,
  }
  const { child, output } = spawn(
    { ...process.env, SYNERGY_HOME: member.home, SYNERGY_RUNTIME_ROOT: member.root },
    [],
    JSON.stringify(input),
  )
  try {
    expect(await child.exited).toBe(1)
    const printed = (await output).join("\n")
    expect(printed).toContain("deployment does not match")
    expect(printed).not.toContain(ticket.token)
    expect(service.requests).toEqual([])
    expect(await Bun.file(path.join(member.root, "authority.sqlite")).exists()).toBe(false)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await output
  }
}, 15_000)
