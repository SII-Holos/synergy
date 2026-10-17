import { expect, test } from "bun:test"
import { createEffect, createRoot, createSignal } from "solid-js"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import {
  createProjectDirectoryResource,
  type ProjectDirectoryOwner,
} from "../../../src/components/session/project-directory-resource"

test("directory snapshots expose pending, success, errors and mutations without requiring view admission", async () => {
  const hit = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const accepted = Promise.withResolvers<void>()
  let requests = 0,
    revision = 1,
    failed = false
  const client = createSynergyClient({
    baseUrl: "http://directories.test",
    fetch: Object.assign(
      async () => {
        if (++requests === 1) {
          hit.resolve()
          await release.promise
        }
        if (failed) return new Response("Directory unavailable", { status: 500 })
        return Response.json({
          version: 1,
          scopeID: "project",
          revision,
          mainWorkspaceID: "main",
          additionalWorkspaceIDs: [],
          folders: [],
        })
      },
      { preconnect() {} },
    ),
  })
  const fixture = createRoot((dispose) => {
    const [owner, select] = createSignal<ProjectDirectoryOwner | false>(false)
    const [snapshot, actions] = createProjectDirectoryResource(owner)
    createEffect(() => {
      if (snapshot.latest?.data && !snapshot.loading) accepted.resolve()
    })
    return { dispose, select, snapshot, actions }
  })
  try {
    expect(fixture.snapshot.latest).toBeNull()
    expect(fixture.snapshot.loading).toBe(false)
    expect(requests).toBe(0)
    fixture.select({ client, scopeID: "project" })
    await hit.promise
    expect(fixture.snapshot.latest).toBeNull()
    expect(fixture.snapshot.loading).toBe(true)
    release.resolve()
    await accepted.promise
    expect(fixture.snapshot.latest).toMatchObject({ client, scopeID: "project", data: { revision: 1 }, error: "" })
    revision = 2
    await fixture.actions.refetch()
    expect(fixture.snapshot.latest?.data?.revision).toBe(2)
    failed = true
    await fixture.actions.refetch()
    expect(fixture.snapshot.latest).toMatchObject({
      client,
      scopeID: "project",
      data: undefined,
      error: "Directory unavailable",
    })
    expect(fixture.snapshot.loading).toBe(false)
    fixture.actions.mutate({
      client,
      scopeID: "project",
      data: {
        version: 1,
        scopeID: "project",
        revision: 3,
        mainWorkspaceID: "main",
        additionalWorkspaceIDs: [],
        folders: [],
      },
      error: "",
    })
    expect(fixture.snapshot.latest?.data?.revision).toBe(3)
    expect(fixture.snapshot.latest?.error).toBe("")
  } finally {
    release.resolve()
    fixture.dispose()
  }
})
