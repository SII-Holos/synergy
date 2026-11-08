import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { openAgentRuntime } from "@ericsanchezok/synergy-agent-runtime"
import { registerWorkerComponents } from "@ericsanchezok/synergy-agent-runtime/workers"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { Skill } from "@ericsanchezok/synergy-local-runtime/skill/skill"
import { SkillSelection } from "@ericsanchezok/synergy-local-runtime/skill/selection"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { SessionExecutionSource } from "@ericsanchezok/synergy-harness/session/execution-source"
import { InstructionFiles } from "@ericsanchezok/synergy-harness/session/instruction-files"
import { spawnAgentWorkerProcess } from "@ericsanchezok/synergy-harness/session/agent-turn/process-host"
import { spawnPolicyWorkerProcess } from "@ericsanchezok/synergy-harness/enforcement/policy-worker/process-host"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { fileLockPath, withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { readMemberRegistration } from "../src/registration"
import { openMemberRuntime } from "../src/runtime"
import { fixture } from "./support/organization"

async function enrolled(service: Awaited<ReturnType<typeof fixture>>) {
  const member = await prepareMemberHome({
    baseDirectory: path.join(service.root, "members"),
    identity: service.identity,
    origin: service.origin,
  })
  await enrollMemberRuntime({
    home: member.home,
    identity: member.identity,
    ticket: await service.ticket(member.identity.deviceID, member.publicKey),
    ca: service.ca,
  })
  return member
}

async function availablePort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = server.port!
  await server.stop(true)
  return port
}

test("resident member startup reconnects its outbound bridge without blocking local readiness", async () => {
  await using service = await fixture()
  const member = await enrolled(service)
  const registration = (await readMemberRegistration(member.home, member.identity))!
  const reconnected = Promise.withResolvers<number>()
  let handshakes = 0
  service.interceptFrames((socket, raw) => {
    const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type === "handshake") handshakes++
    else if (frame.connectionEpoch === 1) socket.close()
    else reconnected.resolve(frame.connectionEpoch)
    return false
  })
  await using runtime = await openMemberRuntime({
    home: member.home,
    identity: member.identity,
    ca: service.ca,
    listen: { port: await availablePort(), token: "d".repeat(64) },
  })
  const deadline = setTimeout(() => reconnected.reject(new Error("Resident bridge did not reconnect")), 3_000)
  try {
    expect(await reconnected.promise).toBe(2)
    expect(handshakes).toBe(2)
    expect(
      (
        await service.client.orgRuntime.connection(
          { runtimeID: registration.runtimeID },
          { headers: service.headers, throwOnError: true },
        )
      ).data,
    ).toMatchObject({ state: "online", connectionEpoch: 2 })
  } finally {
    clearTimeout(deadline)
  }
  await runtime.close()
  await using oneshot = await openMemberRuntime({ home: member.home, identity: member.identity, ca: service.ca })
  expect(handshakes).toBe(2)
}, 15_000)

test("resident readiness and shutdown do not wait for another owner of the connection checkpoint", async () => {
  await using service = await fixture()
  const member = await enrolled(service)
  const directory = path.join(member.root, "state", ".locks")
  const key = "organization-connection"
  const acquired = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const holding = withFileLock({ directory, key }, async () => {
    acquired.resolve()
    await release.promise
  })
  await acquired.promise
  const open = fs.open.bind(fs)
  const observer = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === fileLockPath(directory, key) && args[1] === "wx") waiting.resolve()
    return open(...args)
  })
  let rescued = false
  const rescue = setTimeout(() => {
    rescued = true
    release.resolve()
    waiting.reject(new Error("Member startup did not reach its connection checkpoint"))
  }, 3_000)
  try {
    await using runtime = await openMemberRuntime({
      home: member.home,
      identity: member.identity,
      ca: service.ca,
      listen: { port: await availablePort(), token: "e".repeat(64) },
    })
    await waiting.promise
    expect(runtime.server?.port).toBeGreaterThan(0)
    await runtime.close()
    expect(rescued).toBe(false)
    expect(await Bun.file(path.join(member.root, "organization-connection.json")).exists()).toBe(false)
  } finally {
    clearTimeout(rescue)
    observer.mockRestore()
    release.resolve()
    await holding
  }
}, 15_000)

test("member HTTP services bind explicit loopback ports and keep credentials, identities and shutdown separate", async () => {
  await using a = await fixture()
  await using b = await fixture()
  const [first, second] = await Promise.all([enrolled(a), enrolled(b)])
  const tokenA = "a".repeat(64)
  const tokenB = "b".repeat(64)
  const portA = await availablePort()
  await using one = await openMemberRuntime({
    home: first.home,
    identity: first.identity,
    listen: { port: portA, token: tokenA },
    ca: a.ca,
    entry: "desktop-managed",
  })
  const portB = await availablePort()
  await using two = await openMemberRuntime({
    home: second.home,
    identity: second.identity,
    listen: { port: portB, token: tokenB },
    ca: b.ca,
  })
  expect(one.server?.hostname).toBe("127.0.0.1")
  expect(one.server?.port).toBe(portA)
  expect(two.server?.port).toBe(portB)
  expect(one.run(() => RuntimeContext.current().host.launch?.entry)).toBe("desktop-managed")
  expect(two.run(() => RuntimeContext.current().host.launch?.entry)).toBe("embedded")
  const baseUrl = `http://127.0.0.1:${portA}`
  const apiA = createSynergyClient({ baseUrl, headers: { authorization: `Bearer ${tokenA}` } })
  const apiB = createSynergyClient({
    baseUrl: `http://127.0.0.1:${portB}`,
    headers: { authorization: `Bearer ${tokenB}` },
  })
  expect((await fetch(`${baseUrl}/global/health`)).status).toBe(401)
  expect((await fetch(`${baseUrl}/global/health`, { headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(401)
  const identityA = (await apiA.global.capabilities({ throwOnError: true })).data.runtimeID
  expect((await apiB.global.capabilities({ throwOnError: true })).data.runtimeID).not.toBe(identityA)
  const draft = (await one.client({ scopeID: "home" }).session.create({ title: "member draft" })).data
  expect((await apiA.session.list({ scopeID: "home" }, { throwOnError: true })).data.data.map((row) => row.id)).toEqual(
    [draft.id],
  )
  expect((await apiB.session.list({ scopeID: "home" }, { throwOnError: true })).data.data).toEqual([])
  await one.close()
  await expect(apiA.global.capabilities({ throwOnError: true })).rejects.toThrow()
  expect((await apiB.global.capabilities({ throwOnError: true })).data.runtimeID).toBeDefined()
  await using restarted = await openMemberRuntime({
    home: first.home,
    identity: first.identity,
    listen: { port: portA, token: "c".repeat(64) },
    ca: a.ca,
  })
  expect((await apiA.global.capabilities()).response.status).toBe(401)
  const current = createSynergyClient({ baseUrl, headers: { authorization: `Bearer ${"c".repeat(64)}` } })
  expect((await current.global.capabilities({ throwOnError: true })).data.runtimeID).toBe(identityA)
}, 30_000)

test("invalid listeners and occupied ports never retain a failed member Runtime's storage ownership", async () => {
  await using service = await fixture()
  const member = await enrolled(service)
  for (const listen of [
    { port: 0, token: "a".repeat(64) },
    { port: 65536, token: "a".repeat(64) },
    { port: 48000, token: "weak" },
    { port: 48000, token: "a".repeat(64), hostname: "0.0.0.0" },
  ])
    await expect(
      (async () => {
        await using runtime = await openMemberRuntime({ home: member.home, identity: member.identity, listen })
      })(),
    ).rejects.toThrow("listener")
  expect(await Bun.file(path.join(member.root, "authority.sqlite")).exists()).toBe(false)
  const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const listen = { port: blocker.port!, token: "a".repeat(64) }
  try {
    await expect(
      (async () => {
        await using runtime = await openMemberRuntime({ home: member.home, identity: member.identity, listen })
      })(),
    ).rejects.toThrow("Failed to start server")
  } finally {
    await blocker.stop(true)
  }
  await using reopened = await openMemberRuntime({
    home: member.home,
    identity: member.identity,
    listen,
    ca: service.ca,
  })
  expect(reopened.server?.port).toBe(listen.port)
}, 30_000)

test("personal and two organization Runtimes keep configuration, instructions, Skills, credentials and storage separate", async () => {
  await using a = await fixture()
  await using b = await fixture()
  await using personalHome = await runtimeHome()
  const [first, second] = await Promise.all([enrolled(a), enrolled(b)])
  const privateFile = path.join(personalHome.host.home, "private.md")
  await Bun.write(privateFile, "private explicit instructions")
  const project = path.join(a.root, "project")
  await Bun.write(path.join(a.root, "AGENTS.md"), "ancestor private instructions")
  await Bun.write(path.join(project, "AGENTS.md"), "selected project instructions")
  await Bun.write(
    path.join(project, ".synergy", "synergy.d", "60-agents.jsonc"),
    JSON.stringify({
      project_doc_max_bytes: 512,
      project_doc_fallback_filenames: ["TEAM.md"],
      default_agent: "private-agent",
      instructions: [privateFile],
    }),
  )
  await Bun.write(
    path.join(project, ".synergy", "synergy.d", "20-providers.jsonc"),
    "unselected invalid provider configuration",
  )
  await Bun.write(
    path.join(project, ".agents", "skills", "private", "SKILL.md"),
    "---\nname: private\ndescription: private project Skill\n---\nprivate skill body",
  )
  for (const member of [first, second]) {
    await Bun.write(path.join(member.root, "config", "AGENTS.md"), "member global private instructions")
    await Bun.write(
      path.join(member.root, "config", "synergy.d", "60-agents.jsonc"),
      JSON.stringify({ instructions: [privateFile], default_agent: "private-agent" }),
    )
    await Bun.write(
      path.join(member.root, "config", "synergy.d", "10-models.jsonc"),
      JSON.stringify({ model: "private-provider/private-model" }),
    )
  }
  await Bun.write(path.join(personalHome.host.root, "config", "AGENTS.md"), "personal global instructions")
  const environment = {
    ...personalHome.host.env,
    OPENAI_API_KEY: "private-provider-key",
    SYNERGY_CONFIG_CONTENT: JSON.stringify({ instructions: [privateFile] }),
    NODE_OPTIONS: "--require private.js",
    BASH_ENV: privateFile,
    HTTP_PROXY: "http://private-proxy.invalid",
  }
  await using personal = await openAgentRuntime({
    home: personalHome.host.root,
    host: personalHome.host,
    components: [localRuntime({ workers: false, environment: false })],
  })
  await using one = await openMemberRuntime({ home: first.home, identity: first.identity, environment })
  await using two = await openMemberRuntime({ home: second.home, identity: second.identity, environment })
  for (const [runtime, member] of [
    [one, first],
    [two, second],
  ] as const) {
    await runtime.run(async () => {
      const host = RuntimeContext.current().host
      expect(host.home).toBe(member.home)
      expect(host.env).toMatchObject({
        HOME: member.home,
        USERPROFILE: member.home,
        SYNERGY_HOME: member.home,
        SYNERGY_RUNTIME_ROOT: member.root,
      })
      for (const key of ["OPENAI_API_KEY", "SYNERGY_CONFIG_CONTENT", "NODE_OPTIONS", "BASH_ENV", "HTTP_PROXY"])
        expect(host.env[key]).toBeUndefined()
      expect(JSON.stringify(host.env)).not.toContain("pkcs8")
      expect((await HomeOwnership.assert({ required: true }))?.owner).toBe("organization-runtime")
      expect(EnvironmentProviders.list()).toEqual([])
      const scope = await Scope.registerProject({
        type: "project",
        id: `${member.identity.orgID}:project`,
        local: { directory: project, worktree: project, sandboxes: [] },
        time: { created: Date.now(), updated: Date.now() },
      })
      await ScopeContext.provide({
        scope,
        fn: async () => {
          expect(ScopeContext.current.scope.local?.directory).toBe(project)
          expect(ScopeContext.current.workspace?.path).toBe(await fs.realpath(project))
          const config = await Config.current()
          expect(config.project_doc_max_bytes).toBe(512)
          expect(config.project_doc_fallback_filenames).toEqual(["TEAM.md"])
          expect(config.instructions).toBeUndefined()
          expect(config.model).toBeUndefined()
          expect(config.default_agent).not.toBe("private-agent")
          expect(await Provider.list()).toEqual({})
          expect(await Skill.all()).toEqual([])
          expect((await InstructionFiles.load()).join("\n")).toContain("selected project instructions")
          for (const excluded of [
            "ancestor private instructions",
            "member global private instructions",
            "private explicit instructions",
          ])
            expect((await InstructionFiles.load()).join("\n")).not.toContain(excluded)
          await expect(
            SessionExecutionSource.authorize({ scopeID: scope.id, sessionID: "ses_pending" }),
          ).rejects.toBeInstanceOf(SessionExecutionSource.DeniedError)
        },
      })
    })
  }
  expect(
    (await personal.run(() => ScopeContext.provide({ scope: Scope.home(), fn: InstructionFiles.load }))).join("\n"),
  ).toContain("personal global instructions")
  const firstClient = one.client({ scopeID: "home" })
  const secondClient = two.client({ scopeID: "home" })
  const created = (await firstClient.session.create({ title: "isolated draft" })).data
  expect((await firstClient.session.list()).data.data.map((session) => session.id)).toContain(created.id)
  expect((await secondClient.session.list()).data.data).toEqual([])
  await expect(openMemberRuntime({ home: first.home, identity: first.identity, environment })).rejects.toThrow()
  await one.close()
  expect((await secondClient.session.list()).data.data).toEqual([])
}, 30_000)

test("member startup refuses personal, mismatched and unenrolled Homes before opening Agent storage", async () => {
  await using service = await fixture()
  await using personal = await runtimeHome()
  await expect(openMemberRuntime({ home: personal.host.home, identity: service.identity })).rejects.toThrow()
  expect(await Bun.file(path.join(personal.host.root, "home-ownership.json")).exists()).toBe(false)
  const member = await prepareMemberHome({
    baseDirectory: path.join(service.root, "members"),
    identity: service.identity,
    origin: service.origin,
  })
  await expect(openMemberRuntime({ home: member.home, identity: member.identity })).rejects.toThrow("enrolled")
  await expect(
    openMemberRuntime({ home: member.home, identity: { ...member.identity, accountID: "other" } }),
  ).rejects.toThrow("identity")
  expect(await Bun.file(path.join(member.root, "authority.sqlite")).exists()).toBe(false)
})

test("member workers inherit the exact source selection and validate persisted Home ownership before readiness", async () => {
  await using service = await fixture()
  const member = await enrolled(service)
  await using runtime = await openMemberRuntime({ home: member.home, identity: member.identity })
  await runtime.run(async () => {
    const host = RuntimeContext.current().host
    for (const role of ["agent", "policy"] as const) {
      const child = RuntimeContext.create(host)
      try {
        await child.run(async () => {
          await registerWorkerComponents(role)
          expect(SkillSelection.filesystem()).toBe(false)
          expect((await HomeOwnership.assert({ required: true }))?.owner).toBe("organization-runtime")
          await ScopeContext.provide({
            scope: Scope.home(),
            fn: async () => {
              expect((await Config.current()).instructions).toBeUndefined()
              expect(await Provider.list()).toEqual({})
              expect(await InstructionFiles.load()).toEqual([])
              await expect(
                SessionExecutionSource.authorize({ scopeID: "home", sessionID: "ses_pending" }),
              ).rejects.toBeInstanceOf(SessionExecutionSource.DeniedError)
            },
          })
        })
      } finally {
        child.dispose()
      }
    }
    for (const spawn of [spawnAgentWorkerProcess, spawnPolicyWorkerProcess]) {
      const ready = Promise.withResolvers<number>()
      const timer = setTimeout(() => ready.reject(new Error("Member worker did not become ready")), 10_000)
      const worker = spawn({
        onMessage(message) {
          if (message.type === "ready") ready.resolve(message.pid)
        },
        onExit(code) {
          ready.reject(new Error(`Member worker exited before readiness: ${code}`))
        },
      })
      try {
        expect(await ready.promise).toBe(worker.process.pid)
      } finally {
        clearTimeout(timer)
        await worker.stop(1000)
      }
    }
    const marker = path.join(member.root, "home-ownership.json")
    const original = await Bun.file(marker).text()
    await Bun.write(
      marker,
      JSON.stringify({ schemaVersion: 1, owner: "organization-runtime", identity: "0".repeat(64) }),
    )
    try {
      for (const role of ["agent", "policy"] as const) {
        const child = RuntimeContext.create(host)
        try {
          await expect(child.run(() => registerWorkerComponents(role))).rejects.toThrow("Home owner")
        } finally {
          child.dispose()
        }
      }
    } finally {
      await fs.writeFile(marker, original)
    }
  })
}, 30_000)
