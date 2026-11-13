import { expect, test } from "bun:test"
import { OrganizationCloudProtocol as Cloud } from "../src/cloud"
import { OrganizationHandoffProtocol as Handoff } from "../src/handoff"

test("an initial whole Workspace Locator retains its root provenance without borrowing a move receipt", () => {
  const input = {
    version: 3,
    orgID: "org",
    deploymentIncarnation: "deployment",
    projectID: "project",
    resourceID: "files",
    workspaceID: "workspace",
    generation: 1,
    ownerSessionID: "native-session",
    sessionID: "session",
    rootID: "message",
    grantID: "grant",
    selectionRevision: 1,
  } satisfies Cloud.FileLocator
  expect(Cloud.FileLocator.parse(input)).toEqual(input)
  for (const extra of [
    { path: "subtree" },
    { moveID: "another-move" },
    { handoffID: "another-handoff" },
    { workspaceMoveReceiptHash: "a".repeat(64) },
    { workspaceSourceHash: "b".repeat(64) },
    { mappingRevision: 1 },
  ])
    expect(Cloud.FileLocator.safeParse({ ...input, ...extra }).success).toBe(false)
  for (const key of ["ownerSessionID", "sessionID", "rootID", "grantID", "selectionRevision"] as const) {
    const changed = { ...input, [key]: undefined }
    expect(Cloud.FileLocator.safeParse(changed).success).toBe(false)
  }
  expect(Cloud.FileLocator.safeParse({ ...input, version: 4 }).success).toBe(false)
})

test("whole-root handoff sources preserve the archive root without relaxing object publication destinations", () => {
  const source = { workspaceID: "source", generation: 1 }
  const resource = { resourceID: "files", workspaceID: "cloud", generation: 1, path: "" }
  const live = Handoff.WorkspaceMapping.parse({ kind: "organization-live", source, resource })
  expect(live.kind === "organization-live" && live.resource.path).toBe("")
  const download = Handoff.WorkspaceMapping.parse({
    kind: "organization-native",
    source,
    resource,
    moveID: "download",
    target: { kind: "private-copy" },
  })
  expect(download.kind === "organization-native" && download.resource.path).toBe("")
  expect(
    Handoff.SourceWorkspace.parse({
      reference: { ...source, revision: 1 },
      kind: "organization",
      label: "Workspace root",
      resource,
    }).resource?.path,
  ).toBe("")
  expect(
    Cloud.FileLocator.parse({
      version: 2,
      orgID: "org",
      deploymentIncarnation: "deployment",
      projectID: "project",
      ...resource,
      mappingRevision: 1,
      handoffID: "handoff",
      workspaceSourceHash: "a".repeat(64),
    }).path,
  ).toBe("")
  expect(
    Handoff.WorkspaceMapping.safeParse({
      kind: "organization-object",
      source,
      moveID: "move",
      acceptedDiffHash: null,
      target: { ...resource, expectedRevision: 1 },
    }).success,
  ).toBe(false)
  expect(
    Handoff.WorkspaceMapping.safeParse({ kind: "organization-live", source, resource: { ...resource, path: "." } })
      .success,
  ).toBe(false)
})
