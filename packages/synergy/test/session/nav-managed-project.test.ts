import { describe, expect, test } from "bun:test"
import { ManagedProjectOwnership } from "../../src/channel/managed-project-ownership"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionNav } from "../../src/session/nav"
import { tmpdir } from "../fixture/fixture"

function identity() {
  const suffix = crypto.randomUUID()
  return {
    channelType: "clarus",
    accountId: `agent-${suffix}`,
    externalProjectId: `project-${suffix}`,
  }
}

describe("managed Project navigation projection", () => {
  test("annotates the canonical Scope entry and preserves remote lifecycle", async () => {
    const input = identity()
    const record = await ManagedProjectOwnership.ensure({
      ...input,
      projectName: "Managed project",
      remoteState: "active",
    })

    const active = (await SessionNav.buildScopeIndex()).find((entry) => entry.scopeID === record.scopeID)
    expect(active).toMatchObject({
      scopeID: record.scopeID,
      scopeType: "project",
      managedProject: {
        ...input,
        remoteState: "active",
      },
    })

    await ManagedProjectOwnership.markArchived(input)

    const archived = (await SessionNav.buildScopeIndex()).find((entry) => entry.scopeID === record.scopeID)
    expect(archived).toMatchObject({
      scopeID: record.scopeID,
      managedProject: {
        ...input,
        remoteState: "archived",
      },
    })
  })

  test("leaves ordinary Project Scope entries unmanaged", async () => {
    await using directory = await tmpdir({ git: true })
    const scope = await directory.scope()

    const entry = (await SessionNav.buildScopeIndex()).find((candidate) => candidate.scopeID === scope.id)

    expect(entry).toBeDefined()
    expect(entry?.managedProject).toBeUndefined()
  })

  test("projects Channel task identity into the standard Session nav entry", async () => {
    const input = identity()
    const record = await ManagedProjectOwnership.ensure({ ...input, remoteState: "active" })
    const scope = await Scope.fromID(record.scopeID)
    if (scope?.type !== "project") throw new Error("Expected managed Project Scope")

    const target = {
      kind: "task" as const,
      externalProjectId: input.externalProjectId,
      externalTaskId: `task-${crypto.randomUUID()}`,
    }
    const session = await ScopeContext.provide({
      scope,
      fn: () =>
        Session.create({
          scope,
          title: "Managed task",
          endpoint: SessionEndpoint.fromChannel({
            type: input.channelType,
            accountId: input.accountId,
            target,
          }),
        }),
    })

    const entry = (await SessionNav.buildNavIndex(scope.id)).entries.find((candidate) => candidate.id === session.id)

    expect(entry).toMatchObject({
      id: session.id,
      scopeID: scope.id,
      category: "channel",
      endpointKind: "channel",
      channelType: input.channelType,
      channelAccountId: input.accountId,
      channelTarget: target,
    })
  })
})
