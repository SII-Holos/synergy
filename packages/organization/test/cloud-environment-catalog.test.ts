import { expect, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { OrganizationCloud as Cloud } from "../src/cloud"
import { OrganizationCloudRecord as CloudRecord } from "../src/cloud-records"
import { OrganizationResources as Resources } from "../src/resources"
import { cloudEnvironmentCatalogMigration } from "../src/cloud-environment-catalog-migration"
import { directoryFixture } from "./support/session-directory"

test("Environment catalogs page authorized canonical identities and migrate old locators without allocating compute", async () => {
  await using f = await directoryFixture()
  let allocations = 0
  await f.run(async () => {
    EnvironmentProviders.register({
      id: "catalog-only",
      async allocate() {
        allocations++
        throw new Error("Catalog access must never allocate compute")
      },
      async inspect() {
        throw new Error("Catalog access must not inspect physical execution")
      },
      async deallocate() {
        throw new Error("Catalog access must not deallocate compute")
      },
    })
    Cloud.register({ environmentProfiles: { catalog: { provider: "catalog-only", spec: {} } } })
    const resource = await Resources.create(f.credentials.admin, {
      name: "Execution",
      scope: { kind: "project", projectID: "project" },
      configuration: { protocol: "environment", profile: "catalog" },
      credential: { kind: "none" },
    })
    await Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "account", id: "alice" },
      { expectedRevision: 0, enabled: true },
    )
    const first = await Cloud.createEnvironment(f.credentials.alice, {
      projectID: "project",
      resourceID: resource.resourceID,
      requestID: "first",
      name: "First environment",
    })
    const second = await Cloud.createEnvironment(f.credentials.alice, {
      projectID: "project",
      resourceID: resource.resourceID,
      requestID: "second",
      name: "Second environment",
    })
    const before = await Promise.all(
      [first, second].map((info) => Environment.get(info.environmentID, Cloud.scopeID("org", "project"))),
    )
    const page = await Cloud.listEnvironments(f.credentials.alice, "project", resource.resourceID, { limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.cursor).toBeDefined()
    const next = await Cloud.listEnvironments(f.credentials.alice, "project", resource.resourceID, {
      limit: 1,
      cursor: page.cursor,
    })
    expect(next.cursor).toBeUndefined()
    expect([...page.items, ...next.items].map((info) => info.environmentID).sort()).toEqual(
      [first.environmentID, second.environmentID].sort(),
    )
    await expect(
      Cloud.listEnvironments(f.credentials.bob, "project", resource.resourceID, { limit: 1 }),
    ).rejects.toThrow()
    const prefix = CloudRecord.projectKey("environments", "org", "project", resource.resourceID)
    await Storage.removeTree(prefix)
    expect(
      (await Cloud.listEnvironments(f.credentials.alice, "project", resource.resourceID, { limit: 10 })).items,
    ).toHaveLength(0)
    await cloudEnvironmentCatalogMigration.up(() => {})
    expect(
      (await Cloud.listEnvironments(f.credentials.alice, "project", resource.resourceID, { limit: 10 })).items
        .map((info) => info.environmentID)
        .sort(),
    ).toEqual([first.environmentID, second.environmentID].sort())
    await cloudEnvironmentCatalogMigration.up(() => {})
    expect(await Storage.count({ prefix })).toBe(2)
    expect(
      await Promise.all(
        [first, second].map((info) => Environment.get(info.environmentID, Cloud.scopeID("org", "project"))),
      ),
    ).toEqual(before)
    await Resources.grant(
      f.credentials.admin,
      resource.resourceID,
      { kind: "account", id: "alice" },
      { expectedRevision: 1, enabled: false },
    )
    await expect(
      Cloud.listEnvironments(f.credentials.alice, "project", resource.resourceID, { limit: 1 }),
    ).rejects.toThrow()
    expect(allocations).toBe(0)
  })
})
