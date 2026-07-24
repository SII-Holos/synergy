import { describe, expect, test } from "bun:test"
import { ManagedProjectOwnership } from "../../src/channel/managed-project-ownership"
import { Scope } from "../../src/scope"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"

function identity(label: string) {
  return {
    channelType: "clarus",
    accountId: `agent-${label}`,
    externalProjectId: `project-${label}`,
  }
}

describe("managed Project local archive guard", () => {
  for (const remoteState of ["active", "paused"] as const) {
    test(`rejects local archive while remote state is ${remoteState}`, async () => {
      const record = await ManagedProjectOwnership.ensure({
        ...identity(crypto.randomUUID()),
        remoteState,
      })

      await expect(Scope.remove(record.scopeID)).rejects.toMatchObject({
        name: "ManagedProjectArchiveError",
        data: { scopeID: record.scopeID, remoteState },
      })
      const preserved = await Scope.fromID(record.scopeID)
      if (preserved?.type !== "project") throw new Error("Expected managed Project Scope to remain active")
      expect(preserved.time.archived).toBeUndefined()
    })
  }

  test("returns a structured 409 through the standard Scope archive route", async () => {
    const record = await ManagedProjectOwnership.ensure({
      ...identity(crypto.randomUUID()),
      remoteState: "active",
    })

    const response = await ScopeContext.provide({
      scope: Scope.home(),
      fn: () => Server.App().request(`/scope/${record.scopeID}`, { method: "DELETE" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      name: "ManagedProjectArchiveError",
      data: { scopeID: record.scopeID, remoteState: "active" },
    })
    expect(await Scope.fromID(record.scopeID)).toMatchObject({ id: record.scopeID })
  })
  test("rejects archive attempts through the Scope update route", async () => {
    const record = await ManagedProjectOwnership.ensure({
      ...identity(crypto.randomUUID()),
      remoteState: "active",
    })

    const response = await ScopeContext.provide({
      scope: Scope.home(),
      fn: () =>
        Server.App().request(`/scope/${record.scopeID}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archived: Date.now() }),
        }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      name: "ManagedProjectArchiveError",
      data: { scopeID: record.scopeID, remoteState: "active" },
    })
    expect(await Scope.fromID(record.scopeID)).toMatchObject({ id: record.scopeID })
  })

  test("allows local archive after ownership becomes stale", async () => {
    const input = identity(crypto.randomUUID())
    const record = await ManagedProjectOwnership.ensure({ ...input, remoteState: "active" })
    await ManagedProjectOwnership.markStale(input)

    const archived = await Scope.remove(record.scopeID)

    expect(archived?.time.archived).toBeNumber()
    expect(await Scope.fromID(record.scopeID)).toBeUndefined()
  })

  test("allows local archive after the remote Project is archived", async () => {
    const input = identity(crypto.randomUUID())
    const record = await ManagedProjectOwnership.ensure({ ...input, remoteState: "active" })
    await ManagedProjectOwnership.markArchived(input)

    const archived = await Scope.remove(record.scopeID)

    expect(archived?.time.archived).toBeNumber()
    expect(await Scope.fromID(record.scopeID)).toBeUndefined()
  })

  test("does not affect unmanaged Project or Home Scope behavior", async () => {
    await using dir = await tmpdir({ git: true })
    const scope = await dir.scope()
    if (scope.type !== "project") throw new Error("Expected Project Scope")

    const archived = await Scope.remove(scope.id)

    expect(archived?.time.archived).toBeNumber()
    expect(await Scope.fromID(scope.id)).toBeUndefined()
    expect(await Scope.remove("home")).toBeUndefined()
  })
})
