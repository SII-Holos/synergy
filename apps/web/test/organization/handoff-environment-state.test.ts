import { expect, test } from "bun:test"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import {
  organizationHandoffEnvironmentDefault,
  organizationHandoffEnvironmentMapping,
} from "../../src/organization/handoff-environment-state"

const options = Handoff.Options.parse({
  sessionID: "session",
  projectID: "project",
  bindingEpoch: 1,
  controlRevision: 0,
  sourceRuntimeID: "source",
  targetRuntimeID: "target",
  source: null,
  native: null,
  choices: [],
  environment: {
    expectedSelectionRevision: 2,
    source: { kind: "organization", resourceID: "compute", resourceRevision: 3, environmentID: "shared" },
    native: {
      kind: "native",
      provider: "native",
      descriptor: {
        version: 1,
        kind: "native",
        platform: "linux",
        architecture: "x64",
        capabilities: ["exec", "files"],
      },
      reference: null,
    },
    choices: ["none", "native", "organization"],
  },
})
const cloudFiles = Handoff.WorkspaceMapping.parse({
  kind: "organization-live",
  source: { workspaceID: "alias", generation: 1 },
  resource: { resourceID: "storage", workspaceID: "shared-files", generation: 1, path: "" },
})
const download = Handoff.WorkspaceMapping.parse({
  kind: "organization-native",
  moveID: "download",
  source: cloudFiles.kind === "organization-live" ? cloudFiles.source : {},
  resource: cloudFiles.kind === "organization-live" ? cloudFiles.resource : {},
  target: { kind: "private-copy" },
})

test("cloud-to-member defaults preserve logical compute and require a compatible explicit download choice", () => {
  const environment = options.environment
  if (environment?.source.kind !== "organization" || !environment.native)
    throw new Error("Missing exact inspected Environment choices")
  const selected = organizationHandoffEnvironmentDefault(options)
  expect(selected).toEqual(environment.source)
  const kept = organizationHandoffEnvironmentMapping(options, cloudFiles, selected)
  expect(kept?.target).toEqual(selected)
  expect(organizationHandoffEnvironmentMapping(options, download, selected)).toBeUndefined()
  expect(
    organizationHandoffEnvironmentMapping(options, download, options.environment?.native ?? undefined)?.target,
  ).toEqual(environment.native)
  expect(organizationHandoffEnvironmentMapping(options, download, { kind: "none" })?.target.kind).toBe("none")
})

test("native mapping requires the original inspected template and keeps the exact resource revision", () => {
  const target = options.environment?.native
  if (!target) throw new Error("Missing actual native target metadata")
  expect(organizationHandoffEnvironmentMapping(options, cloudFiles, target)).toBeUndefined()
  expect(organizationHandoffEnvironmentMapping(options, download, { ...target, provider: "invented" })).toBeUndefined()
  const mapping = organizationHandoffEnvironmentMapping(options, cloudFiles, {
    kind: "organization",
    resourceID: "new-compute",
    resourceRevision: 7,
    environmentID: "new-environment",
  })
  expect(mapping?.expectedSelectionRevision).toBe(2)
  expect(mapping?.target.kind === "organization" && mapping.target.resourceRevision).toBe(7)
  expect(organizationHandoffEnvironmentDefault({ ...options, environment: undefined })).toBeUndefined()
})
