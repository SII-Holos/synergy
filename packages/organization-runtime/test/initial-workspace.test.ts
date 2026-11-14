import { expect, spyOn, test } from "bun:test"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { OrganizationCloudProtocol as Cloud } from "@ericsanchezok/synergy-organization-protocol"
import { readCommandControlVersion } from "../src/command-intake"
import { cloudExecutionFixture } from "./support/cloud-execution"

test.skipIf(process.platform === "win32")(
  "a new accepted task reuses its original initial Working after interrupted Session publication",
  async () => {
    await using f = await cloudExecutionFixture()
    const machine = await f.member("initial-working-retry")
    const member = await machine.sibling({ environment: null })
    const originalAccepted = member.accepted
    const headers = { headers: f.service.headers, throwOnError: true as const }
    const text = "initial Working survives interrupted Session publication\n"
    await f.service.client.orgCloudWorkspaces.write(
      {
        workspaceID: f.workspace.workspaceID,
        orgCloudWorkspaceWrite: {
          operationID: "initial-working-retry-bytes",
          expectedRevision: (await f.head()).revision,
          path: "retry.txt",
          data: Buffer.from(text).toString("base64"),
          expectedVersion: null,
        },
      },
      headers,
    )
    const interrupted = new Error("Initial Session publication was interrupted after Catalog commit")
    let intercepted = false
    const updateWorkspace = Session.updateWorkspace
    {
      using publication = spyOn(Session, "updateWorkspace").mockImplementation(
        async (sessionID, workspace, options) => {
          if (sessionID === member.sessionID && options?.reference && !intercepted) {
            intercepted = true
            throw interrupted
          }
          return updateWorkspace(sessionID, workspace, options)
        },
      )
      let outcome: unknown
      try {
        await member.read("retry.txt")
      } catch (error) {
        outcome = error
      }
      expect(outcome).toBe(interrupted)
      expect(intercepted).toBe(true)
    }
    const original = await member.runtime.run(async () => {
      const session = await Session.get(member.sessionID)
      expect(session.workspaceID).toBeNull()
      const aliases = (await WorkspaceCatalog.list(session.scope.id)).filter((row) => {
        if (row.backend?.provider !== "organization") return false
        const spec = Cloud.FileLocator.parse(row.backend.spec)
        return spec.version === 3 && spec.ownerSessionID === session.id
      })
      expect(aliases).toHaveLength(1)
      const alias = aliases[0]
      if (!alias) throw new Error("The original Catalog did not publish its initial Working")
      const locator = Cloud.FileLocator.parse(alias.backend?.spec)
      if (locator.version !== 3) throw new Error("The original Working has another file owner")
      expect(locator.rootID).toBe(originalAccepted.effect.messageID)
      expect(locator.workspaceID).toBe(f.workspace.workspaceID)
      return { alias, locator }
    })
    const controlVersion = await member.runtime.run(() =>
      readCommandControlVersion(f.service.identity.orgID, member.sessionID),
    )
    const cancelled = (
      await f.service.client.orgCommands.control(
        {
          sessionID: member.sessionID,
          orgCommandControlRequest: {
            schemaVersion: 1,
            orgID: f.service.identity.orgID,
            projectID: f.project.projectID,
            runtimeID: member.registration.runtimeID,
            sessionID: member.sessionID,
            requestID: "cancel-interrupted-initial-working",
            control: { operation: "cancel", runID: originalAccepted.effect.messageID, controlVersion },
          },
        },
        headers,
      )
    ).data
    expect(cancelled.effect.operation).toBe("cancel")
    const cancellation = AbortSignal.timeout(5000)
    for (;;) {
      cancellation.throwIfAborted()
      const run = await member.runtime.run(async () => {
        const session = await Session.get(member.sessionID)
        return RolloutLedger.getRun(RolloutLifecycle.owner(session), originalAccepted.effect.messageID)
      })
      if (run.status === "cancelled") break
      await Bun.sleep(10)
    }
    const next = await member.nextTask()
    expect(next.effect.messageID).not.toBe(originalAccepted.effect.messageID)
    expect((await member.read("retry.txt")).output).toContain(text.trimEnd())
    await member.runtime.run(async () => {
      const session = await Session.get(member.sessionID)
      expect(session.workspaceID).toBe(original.alias.id)
      expect(session.workspace).toBeNull()
      expect(await WorkspaceCatalog.get(original.alias.id, session.scope.id)).toEqual(original.alias)
      expect(
        (await WorkspaceCatalog.list(session.scope.id)).filter((row) => row.id === original.alias.id),
      ).toHaveLength(1)
    })
    expect(f.allocations()).toBe(0)
  },
  30000,
)
