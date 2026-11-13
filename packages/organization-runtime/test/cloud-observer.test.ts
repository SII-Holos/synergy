import { expect, test } from "bun:test"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { OrganizationCloudProtocol as Cloud } from "@ericsanchezok/synergy-organization-protocol"
import { cloudExecutionFixture } from "./support/cloud-execution"

async function inventory() {
  const environments: string[] = []
  const executions: string[] = []
  const uses: string[] = []
  for await (const info of Environment.entries()) environments.push(JSON.stringify([info.scopeID, info.id]))
  for await (const info of EnvironmentExecution.entries()) executions.push(JSON.stringify([info.scopeID, info.id]))
  for await (const use of Environment.useEntries()) uses.push(use.id)
  return { environments: environments.sort(), executions: executions.sort(), uses: uses.sort() }
}

test.skipIf(process.platform === "win32")(
  "a Workspace observer without an Environment reads another root's live files and rechecks current access",
  async () => {
    const f = await cloudExecutionFixture()
    const failures: unknown[] = []
    try {
      const alice = await f.member("observer-writer")
      const text = "live bytes for an observer without compute\n"
      const program = [
        `await Bun.write('observer.txt', ${JSON.stringify(text)});`,
        "process.stdout.write('OBSERVER_WRITER_READY\\n');",
        "const input = await new Promise(resolve => process.stdin.once('data', resolve));",
        "if (Buffer.from(input).toString() !== 'finish\\n') throw new Error('Unexpected writer input');",
        "process.stdin.destroy();",
      ].join("\n")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const started = await alice.bash(`${quote(process.execPath)} -e ${quote(program)}`)
      const processId = started.result.metadata.processId
      expect(started.result.metadata.background).toBe(true)
      if (!processId) throw new Error("The original writer has no actual background process")
      await f.waitForOutput(started.executionID, "OBSERVER_WRITER_READY")
      const original = await f.physical(started.executionID)
      expect(original.execution.state).toBe("running")
      expect(original.workspace.activeMount?.state).toBe("active")
      expect(f.allocations()).toBe(1)

      const service = f.service
      const owner = { headers: service.headers, throwOnError: true as const }
      const invite = (await service.client.orgInvites.create({ orgInviteCreate: { role: "member" } }, owner)).data
      const password = "workspace observer integration password"
      const actor = (
        await service.client.orgInvites.consume(
          {
            orgInviteConsume: {
              token: invite.token,
              requestID: "workspace-observer",
              loginName: "workspace-observer",
              displayName: "Workspace observer",
              password,
            },
          },
          { throwOnError: true },
        )
      ).data
      const login = await service.client.orgAuth.login(
        { orgLoginInput: { loginName: "workspace-observer", password } },
        { throwOnError: true },
      )
      const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
      if (!cookie) throw new Error("The observer's actual login did not establish a session")
      const headers = { cookie, "x-csrf-token": login.data.csrfToken }
      await service.client.orgProjects.member(
        {
          projectID: f.project.projectID,
          accountID: actor.accountID,
          orgProjectMemberChange: { expectedRevision: f.project.revision, role: "collaborator" },
        },
        owner,
      )
      const [model, workspace, compute] = f.resourceIDs
      if (!model || !workspace || !compute) throw new Error("The original fixture has incomplete resource identities")
      for (const resourceID of [model, workspace])
        await service.client.orgResourceGrants.set(
          {
            resourceID,
            kind: "account",
            subjectID: actor.accountID,
            orgResourceGrantChange: { expectedRevision: 0, enabled: true },
          },
          owner,
        )
      const available = (
        await service.client.orgProjectResources.list(
          { projectID: f.project.projectID, limit: 100 },
          { headers, throwOnError: true },
        )
      ).data
      expect(available.cursor).toBeUndefined()
      expect(available.items.find((item) => item.resourceID === model)?.permissions.use).toBe(true)
      expect(available.items.find((item) => item.resourceID === workspace)?.permissions.use).toBe(true)
      expect(available.items.some((item) => item.resourceID === compute && item.permissions.use)).toBe(false)
      const machine = await f.member("observer-reader")
      const observer = await machine.sibling({ inputHeaders: headers, environment: null })
      expect(observer.accepted.permit.actor.subjectID).toBe(actor.accountID)
      const contract = (
        await service.client.orgSessionResources.get({ sessionID: observer.sessionID }, { headers, throwOnError: true })
      ).data
      expect(contract.selection?.infrastructure.environment).toBeNull()
      expect(contract.selection?.infrastructure.workspace?.workspaceID).toBe(f.workspace.workspaceID)
      const originalScope = await alice.runtime.run(async () => (await Session.get(alice.sessionID)).scope.id)
      expect(await observer.runtime.run(async () => (await Session.get(observer.sessionID)).scope.id)).toBe(
        originalScope,
      )
      const serviceBefore = await service.service.maintenance.run(inventory)
      const memberBefore = await observer.runtime.run(inventory)
      const described = await observer.files({ operation: { action: "describe" } })
      const read = await observer.files({
        reference: described.reference,
        operation: { action: "read", path: "observer.txt", offset: 0, maximumBytes: 128 },
      })
      expect(read.result).toMatchObject({ action: "read", data: Buffer.from(text).toString("base64") })
      expect((await observer.read("observer.txt")).output).toContain(text.trimEnd())
      await observer.runtime.run(async () => {
        const session = await Session.get(observer.sessionID)
        if (!session.workspaceID) throw new Error("The accepted observer has no original Working binding")
        const alias = await WorkspaceCatalog.get(session.workspaceID, session.scope.id)
        const locator = Cloud.FileLocator.parse(alias.backend?.spec)
        expect(locator.version).toBe(3)
        expect(locator.workspaceID).toBe(f.workspace.workspaceID)
        expect(alias.binding.path).toBeNull()
        expect(alias.content).toBeUndefined()
        expect(session.workspace).toBeNull()
      })
      expect((await f.physical(started.executionID)).execution.state).toBe("running")
      await expect(observer.bash("printf OBSERVER_NATIVE_FALLBACK")).rejects.toThrow(
        "Organization execution requires an explicit Workspace and Environment pair",
      )
      expect(await service.service.maintenance.run(inventory)).toEqual(serviceBefore)
      expect(await observer.runtime.run(inventory)).toEqual(memberBefore)
      expect(f.allocations()).toBe(1)
      expect((await f.head()).contentRevision).toBe(f.workspace.contentRevision)

      const project = (await service.client.orgProjects.get({ projectID: f.project.projectID }, owner)).data
      await service.client.orgProjects.member(
        {
          projectID: f.project.projectID,
          accountID: actor.accountID,
          orgProjectMemberChange: { expectedRevision: project.revision, role: null },
        },
        owner,
      )
      expect([403, 404]).toContain(
        (await service.client.orgSessions.get({ sessionID: observer.sessionID }, { headers })).response.status,
      )
      const revoked = await observer.filesResponse({
        reference: described.reference,
        operation: { action: "read", path: "observer.txt", offset: 0, maximumBytes: 128 },
      })
      expect([403, 404]).toContain(revoked.response.status)
      await expect(observer.read("observer.txt")).rejects.toThrow()
      expect(await service.service.maintenance.run(inventory)).toEqual(serviceBefore)
      expect(await observer.runtime.run(inventory)).toEqual(memberBefore)
      expect(f.allocations()).toBe(1)
      await alice.process({ action: "write", processId, data: "finish\n" })
      expect(
        (await alice.process({ action: "poll", processId, block: true, timeoutSeconds: 5 })).metadata,
      ).toMatchObject({
        status: "completed",
        exitCode: 0,
      })
    } catch (error) {
      failures.push(error)
    }
    try {
      await f[Symbol.asyncDispose]()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, "Workspace observer and original native cleanup failed")
  },
  30000,
)
