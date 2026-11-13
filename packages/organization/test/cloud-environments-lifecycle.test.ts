import { expect, test } from "bun:test"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationIdentity as Identity,
  OrganizationResourceProtocol as Resource,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationCloud, type OrganizationCloudOptions } from "../src/cloud"
import { fixture } from "./support/organization"

test("cold service startup requires the original persisted Environment provider before accepting work", async () => {
  const calls = { allocate: 0, resume: 0, inspect: 0, deallocate: 0 }
  const provider = {
    id: "cold-service-provider",
    async allocate() {
      calls.allocate++
      throw new Error("This preflight must not allocate")
    },
    async resume() {
      calls.resume++
      throw new Error("This preflight must not resume")
    },
    async inspect(): Promise<{ state: "absent" }> {
      calls.inspect++
      return { state: "absent" }
    },
    async deallocate() {
      calls.deallocate++
      throw new Error("This preflight must not deallocate")
    },
  }
  const profiles = { standard: { provider: provider.id, spec: {} } }
  const cloud: OrganizationCloudOptions = { environmentProviders: [provider], environmentProfiles: profiles }
  await using f = await fixture(undefined, { cloud })
  const owner = await f.initialize()
  const projectResponse = await owner.request("POST", "/projects", { name: "Cold provider" })
  expect(projectResponse.status).toBe(200)
  const project = Identity.ProjectView.parse(await projectResponse.json())
  const resourceResponse = await owner.request("POST", "/resources", {
    name: "Execution",
    scope: { kind: "project", projectID: project.projectID },
    configuration: { protocol: "environment", profile: "standard" },
    credential: { kind: "none" },
  })
  expect(resourceResponse.status).toBe(200)
  const resource = Resource.AdminView.parse(await resourceResponse.json())
  const granted = await owner.request("PUT", `/resources/${resource.resourceID}/grants/project/${project.projectID}`, {
    expectedRevision: 0,
    enabled: true,
  })
  expect(granted.status).toBe(200)
  const created = await owner.request("POST", "/cloud/environments", {
    projectID: project.projectID,
    resourceID: resource.resourceID,
    requestID: "cold-provider",
    name: "Original",
  })
  expect(created.status).toBe(200)
  const selected = Cloud.Environment.parse(await created.json())
  const before = await f.service.maintenance.run(() =>
    Environment.get(selected.environmentID, OrganizationCloud.scopeID(selected.orgID, selected.projectID)),
  )
  expect(before.state).toBe("idle")
  cloud.environmentProviders = []
  cloud.environmentProfiles = {}
  await expect(f.restart()).rejects.toThrow()
  expect(calls).toEqual({ allocate: 0, resume: 0, inspect: 0, deallocate: 0 })
  cloud.environmentProviders = [provider]
  cloud.environmentProfiles = profiles
  await f.restart()
  const after = await f.service.maintenance.run(() =>
    Environment.get(selected.environmentID, OrganizationCloud.scopeID(selected.orgID, selected.projectID)),
  )
  expect(after).toEqual(before)
  expect(calls).toEqual({ allocate: 0, resume: 0, inspect: 0, deallocate: 0 })
})
