import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { memberEnvironment } from "../src/environment"
import { readRuntimeHome } from "../src/home"
import { readRuntimeRegistration } from "../src/registration"
import { fixture } from "./support/organization"

const installed = process.env.SYNERGY_TEST_ORGANIZATION_RUNTIME_INSTALL
const entry = installed
  ? path.join(installed, "node_modules/.bin/synergy-org-runtime")
  : path.resolve(import.meta.dir, "../src/entry.ts")

async function invoke(args: string[], input: unknown, ambient: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-bunfig", entry, ...args], {
    cwd: installed ?? ambient,
    env: {
      ...process.env,
      SYNERGY_HOME: ambient,
      SYNERGY_RUNTIME_ROOT: undefined,
      NODE_PATH: undefined,
      NODE_OPTIONS: undefined,
    },
    stdin: new TextEncoder().encode(typeof input === "string" ? input : JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test("public register prepares and enrolls member and hosted Homes over TLS without changing the ambient Home", async () => {
  await using f = await fixture()
  const ambient = path.join(f.root, "ambient")
  await fs.mkdir(ambient)
  const help = await invoke(["--help"], {}, ambient)
  expect(help.code, help.stderr).toBe(0)
  expect(help.stdout).toContain("register")
  expect(help.stdout).toContain("serve")
  for (const kind of ["member", "hosted"] as const) {
    const base = path.join(f.root, kind)
    const identity = kind === "member" ? f.identity : { orgID: f.identity.orgID, hostID: "public-registration" }
    const input = { version: 1, identity, origin: f.origin, ca: f.ca }
    const args = ["register", "--base-directory", base]
    const prepared = await invoke(args, input, ambient)
    expect(prepared.code, prepared.stderr).toBe(0)
    const ready = JSON.parse(prepared.stdout)
    expect(ready).toMatchObject({ state: "prepared", kind, identity })
    const home = await readRuntimeHome(ready.home, identity)
    expect(home.publicKey).toBe(ready.publicKey)
    const before = f.requests.length
    const ticket =
      kind === "member"
        ? await f.ticket(f.identity.deviceID, home.publicKey)
        : (
            await f.client.orgRuntime.registerHosted(
              { orgHostedRuntimeRegistration: { name: "Public registration", publicKey: home.publicKey } },
              { headers: f.headers, throwOnError: true },
            )
          ).data
    const enrolled = await invoke(args, { ...input, ticket }, ambient)
    expect(enrolled.code, enrolled.stderr).toBe(0)
    expect(JSON.parse(enrolled.stdout)).toMatchObject({
      state: "active",
      kind,
      home: home.home,
      publicKey: home.publicKey,
      runtimeID: ticket.runtime.runtimeID,
      deploymentIncarnation: ticket.runtime.deploymentIncarnation,
    })
    expect((await readRuntimeHome(home.home, identity)).publicKey).toBe(home.publicKey)
    expect((await readRuntimeRegistration(home.home, identity))?.state).toBe("active")
    const retained = await invoke(args, input, ambient)
    expect(retained.code, retained.stderr).toBe(0)
    expect(JSON.parse(retained.stdout)).toMatchObject({ state: "active", runtimeID: ticket.runtime.runtimeID })
    expect(f.requests.length - before).toBe(1)
    expect(enrolled.stdout + enrolled.stderr).not.toContain(ticket.token)
  }
  expect(await fs.readdir(ambient, { recursive: true })).toEqual([])
}, 25_000)

test("public registration rejects malformed input and foreign tickets before remote dispatch", async () => {
  await using f = await fixture()
  const ambient = path.join(f.root, "ambient")
  await fs.mkdir(ambient)
  const base = path.join(f.root, "member")
  for (const input of ["{", { version: 2 }, " ".repeat(65_537)]) {
    const result = await invoke(["register", "--base-directory", base], input, ambient)
    expect(result.code).toBe(1)
    expect(await fs.readdir(f.root)).not.toContain("member")
  }
  const relative = await invoke(["register", "--base-directory", "relative"], {}, ambient)
  expect(relative.code).toBe(1)
  expect(await fs.readdir(ambient)).toEqual([])
  const input = { version: 1, identity: f.identity, origin: f.origin, ca: f.ca }
  const prepared = await invoke(["register", "--base-directory", base], input, ambient)
  expect(prepared.code, prepared.stderr).toBe(0)
  const ready = JSON.parse(prepared.stdout)
  const ticket = await f.ticket(f.identity.deviceID, ready.publicKey)
  const foreign = {
    ...ticket,
    runtime: { ...ticket.runtime, deviceID: "different-device" },
  }
  const rejected = await invoke(["register", "--base-directory", base], { ...input, ticket: foreign }, ambient)
  expect(rejected.code).toBe(1)
  expect(f.requests).toHaveLength(0)
  expect(rejected.stdout + rejected.stderr).not.toContain(ticket.token)
  expect(await readRuntimeRegistration(ready.home, f.identity)).toBeUndefined()
}, 25_000)

test("registration response loss preserves the prepared key and requires an explicit same-ticket reconciliation", async () => {
  await using f = await fixture()
  const ambient = path.join(f.root, "ambient")
  await fs.mkdir(ambient)
  const args = ["register", "--base-directory", path.join(f.root, "member")]
  const input = { version: 1, identity: f.identity, origin: f.origin, ca: f.ca }
  const prepared = await invoke(args, input, ambient)
  expect(prepared.code, prepared.stderr).toBe(0)
  const home = JSON.parse(prepared.stdout)
  const ticket = await f.ticket(f.identity.deviceID, home.publicKey)
  const fingerprint = () =>
    fs
      .readFile(path.join(home.home, ".synergy", "auth", "organization-runtime.json"))
      .then((bytes) => createHash("sha256").update(bytes).digest("hex"))
  const before = await fingerprint()
  f.loseRegistrationResponse()
  const lost = await invoke(args, { ...input, ticket }, ambient)
  expect(lost.code).toBe(1)
  expect(f.requests).toHaveLength(1)
  expect(await fingerprint()).toBe(before)
  expect(await readRuntimeRegistration(home.home, f.identity)).toBeUndefined()
  const retried = await invoke(args, { ...input, ticket }, ambient)
  expect(retried.code, retried.stderr).toBe(0)
  expect(f.requests).toHaveLength(2)
  expect(await fingerprint()).toBe(before)
  expect((await readRuntimeRegistration(home.home, f.identity))?.runtimeID).toBe(ticket.runtime.runtimeID)
  expect(lost.stdout + lost.stderr + retried.stdout + retried.stderr).not.toContain(ticket.token)
}, 25_000)

test("public serve reuses the enrolled supervised lifecycle and graceful shutdown", async () => {
  await using f = await fixture()
  const ambient = path.join(f.root, "ambient")
  await fs.mkdir(ambient)
  const identity = { orgID: f.identity.orgID, hostID: "public-serve" }
  const input = { version: 1, identity, origin: f.origin, ca: f.ca }
  const args = ["register", "--base-directory", path.join(f.root, "hosted")]
  const prepared = await invoke(args, input, ambient)
  expect(prepared.code, prepared.stderr).toBe(0)
  const ready = JSON.parse(prepared.stdout)
  const ticket = (
    await f.client.orgRuntime.registerHosted(
      { orgHostedRuntimeRegistration: { name: "Public serve", publicKey: ready.publicKey } },
      { headers: f.headers, throwOnError: true },
    )
  ).data
  const enrolled = await invoke(args, { ...input, ticket }, ambient)
  expect(enrolled.code, enrolled.stderr).toBe(0)
  const home = await readRuntimeHome(ready.home, identity)
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  const token = "c".repeat(64)
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-bunfig", entry, "serve", "--kind", "hosted"], {
    cwd: installed ?? home.home,
    env: { ...memberEnvironment(home, process.env), NODE_PATH: undefined, NODE_OPTIONS: undefined },
    stdin: new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        identity,
        deploymentIncarnation: ticket.runtime.deploymentIncarnation,
        port,
        token,
        ca: f.ca,
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  try {
    const client = createSynergyClient({
      baseUrl: `http://127.0.0.1:${port}`,
      headers: { authorization: `Bearer ${token}` },
    })
    let running = false
    const deadline = Date.now() + 12_000
    while (!running && child.exitCode === null && Date.now() < deadline) {
      const capabilities = await client.global.capabilities({ signal: AbortSignal.timeout(250) }).catch(() => undefined)
      running = !!capabilities?.data?.runtimeID
      if (!running) await Bun.sleep(25)
    }
    if (child.exitCode !== null) throw new Error((await output).join("\n"))
    expect(running).toBe(true)
    child.kill("SIGTERM")
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
}, 25_000)
