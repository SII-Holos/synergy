import { expect, test } from "bun:test"
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
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
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
