import { expect, test } from "bun:test"
import { OrganizationSessionProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionExport } from "@ericsanchezok/synergy-harness/session/session-export"
import { SessionImport } from "@ericsanchezok/synergy-harness/session/session-import"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerSessionSchema, SessionBindingError } from "../src/session-schema"

const binding: Protocol.Binding = {
  schemaVersion: 1,
  orgID: "org-a",
  projectID: "project-a",
  creatorID: "account-a",
  driverRuntimeID: "runtime-a",
  bindingEpoch: 1,
}

function project() {
  return Scope.registerProject({
    type: "project",
    id: binding.projectID,
    local: null,
    time: { created: 1, updated: 1 },
  })
}

test("member Sessions require fixed project bindings and their children inherit the same authority", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema({ orgID: binding.orgID }) })
  await runtime.run(async () => {
    const scope = await project()
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        await expect(Session.create({})).rejects.toBeInstanceOf(SessionBindingError)
        const root = await Session.create({ organization: binding, workspaceID: null })
        const child = await Session.create({ parentID: root.id })
        expect(Session.publicInfo(root).organization).toEqual(binding)
        expect(Session.publicInfo(child).organization).toEqual(binding)
        expect(root.scope.id).toBe(binding.projectID)
        expect(child.scope.id).toBe(binding.projectID)
        const before = await Session.get(root.id)
        for (const organization of [
          undefined,
          { ...binding, orgID: "org-b" },
          { ...binding, projectID: "project-b" },
          { ...binding, creatorID: "account-b" },
          { ...binding, driverRuntimeID: "runtime-b" },
          { ...binding, bindingEpoch: 2 },
        ]) {
          await expect(
            Session.update(root.id, (draft) => {
              draft.organization = organization
            }),
          ).rejects.toBeInstanceOf(SessionBindingError)
        }
        await expect(
          Session.update(root.id, (draft) => {
            draft.scope = { ...scope, id: "another-project" }
          }),
        ).rejects.toBeInstanceOf(SessionBindingError)
        await expect(
          Session.update(root.id, (draft) => {
            draft.parentID = child.id
          }),
        ).rejects.toBeInstanceOf(SessionBindingError)
        await expect(
          Session.update(root.id, (draft) => {
            draft.id = "ses_another"
          }),
        ).rejects.toBeInstanceOf(SessionBindingError)
        expect(await Session.get(root.id)).toEqual(before)
        await expect(
          Session.create({ parentID: root.id, organization: { ...binding, creatorID: "account-b" } }),
        ).rejects.toBeInstanceOf(SessionBindingError)
        await expect(Session.create({ organization: { ...binding, orgID: "org-b" } })).rejects.toBeInstanceOf(
          SessionBindingError,
        )
        await expect(
          Session.create({ organization: binding, scope: Scope.home(), workspaceID: null }),
        ).rejects.toBeInstanceOf(SessionBindingError)
        expect((await Session.list({ parentOnly: false })).total).toBe(2)
        await Session.update(root.id, (draft) => {
          draft.title = "Ordinary metadata edit"
        })
        expect((await Session.get(root.id)).organization).toEqual(binding)
      },
    })
  })
})

test("independent member Homes use the same organization project Scope identity", async () => {
  await using first = await testRuntime({ register: () => registerSessionSchema({ orgID: binding.orgID }) })
  await using second = await testRuntime({ register: () => registerSessionSchema({ orgID: binding.orgID }) })
  const results = await Promise.all(
    [first, second].map((runtime, index) =>
      runtime.run(async () => {
        const scope = await project()
        return ScopeContext.provide({
          scope,
          workspace: null,
          fn: () =>
            Session.create({
              organization: { ...binding, driverRuntimeID: `runtime-${index}`, creatorID: `account-${index}` },
            }),
        })
      }),
    ),
  )
  expect(results.map((session) => session.scope.id)).toEqual([binding.projectID, binding.projectID])
  expect(results[0].id).not.toBe(results[1].id)
  expect(results[0].organization?.driverRuntimeID).not.toBe(results[1].organization?.driverRuntimeID)
})

test("unloaded bindings remain on disk and return after reinstall without adopting personal history", async () => {
  await using home = await tmpdir()
  let id = ""
  let personalID = ""
  {
    await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema() })
    await runtime.run(async () => {
      const scope = await project()
      await ScopeContext.provide({
        scope,
        workspace: null,
        fn: async () => {
          id = (await Session.create({ organization: binding, title: "Bound" })).id
          personalID = (await Session.create({ title: "Unknown historical owner" })).id
        },
      })
    })
  }
  {
    await using runtime = await testRuntime({ home: home.path })
    await runtime.run(async () => {
      await ScopeContext.provide({
        scope: await project(),
        workspace: null,
        fn: async () => {
          expect((await Session.get(id)).organization).toEqual(binding)
          expect(Session.publicInfo(await Session.get(id)).organization).toBeUndefined()
          await Session.update(id, (draft) => {
            draft.title = "Edited while owner is unloaded"
          })
        },
      })
    })
  }
  await using restored = await testRuntime({
    home: home.path,
    register: () => registerSessionSchema({ orgID: binding.orgID }),
  })
  await restored.run(async () => {
    await ScopeContext.provide({
      scope: await project(),
      workspace: null,
      fn: async () => {
        const value = await Session.get(id)
        expect(Session.publicInfo(value).organization).toEqual(binding)
        expect(value.title).toBe("Edited while owner is unloaded")
        expect((await Session.get(personalID)).organization).toBeUndefined()
        await Session.update(personalID, (draft) => {
          draft.title = "Retained without invented ownership"
        })
        await expect(
          Session.update(personalID, (draft) => {
            draft.organization = binding
          }),
        ).rejects.toBeInstanceOf(SessionBindingError)
        expect((await Session.get(personalID)).organization).toBeUndefined()
      },
    })
  })
})

test("ordinary transcript import and fork cannot mint an organization Session binding", async () => {
  await using runtime = await testRuntime({ register: () => registerSessionSchema({ orgID: binding.orgID }) })
  await runtime.run(async () => {
    const scope = await project()
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const root = await Session.create({ organization: binding })
        const report = await SessionExport.generate({ sessionID: root.id, mode: "full" })
        await expect(SessionImport.fromBuffer(new TextEncoder().encode(JSON.stringify(report)))).rejects.toBeInstanceOf(
          SessionBindingError,
        )
        await expect(Session.fork({ sessionID: root.id })).rejects.toBeInstanceOf(SessionBindingError)
        expect((await Session.list({ parentOnly: false })).data.map((entry) => entry.id)).toEqual([root.id])
        expect((await Session.get(root.id)).organization).toEqual(binding)
      },
    })
  })
})
