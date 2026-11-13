import { expect, test } from "bun:test"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import {
  organizationDirectoryFromOptions,
  organizationDirectoryLabel,
} from "../../src/organization/handoff-directory-state"

const mapping = {
  kind: "organization-native" as const,
  moveID: "move",
  source: { workspaceID: "cloud", generation: 4 },
  resource: { resourceID: "storage", workspaceID: "cloud", generation: 4, path: "project" },
  target: {
    kind: "existing" as const,
    workspaceID: "native",
    generation: 2,
    expectedRevision: 3,
    projectRevision: "a".repeat(64),
  },
}
const plan = Handoff.CurrentPrepare.parse({
  handoffID: "handoff",
  targetRuntimeID: "target",
  expectedBindingEpoch: 7,
  expectedControlRevision: 11,
  mappingPlanRevision: 1,
  workspaceMapping: mapping,
})
const options = Handoff.Options.parse({
  sessionID: "session",
  projectID: "project",
  bindingEpoch: 7,
  controlRevision: 11,
  sourceRuntimeID: "source",
  targetRuntimeID: "target",
  source: {
    kind: "organization",
    label: "Team files",
    reference: { workspaceID: "cloud", generation: 4, revision: 1 },
    resource: mapping.resource,
  },
  native: {
    label: "Originally selected folder",
    reference: { workspaceID: "native", generation: 2, revision: 3 },
    projectRevision: mapping.target.projectRevision,
  },
  choices: [{ kind: "organization-native", requiresDifference: true }],
})
const view = Handoff.View.parse({
  schemaVersion: 1,
  orgID: "org",
  deploymentIncarnation: "inc",
  handoffID: "handoff",
  sessionID: "session",
  sourceRuntimeID: "source",
  targetRuntimeID: "target",
  fromEpoch: 7,
  toEpoch: 8,
  mappingPlanRevision: 1,
  shareGeneration: 0,
  phase: "preparing",
  initiator: "account",
  targetAccepted: true,
  cancelRequested: false,
  commandSeq: 1,
  missingRequirements: [],
  canAccept: true,
  canCancel: true,
  canContinue: false,
  currentDriver: "source",
  bindingEpoch: 7,
  workspaceMapping: mapping,
  mappingHash: "b".repeat(64),
})

test("only the original authorized preflight can supply an existing directory label", () => {
  const input = { plan, options, sessionID: "session", projectID: "project" }
  expect(organizationDirectoryFromOptions(input)).toEqual({ plan, label: "Originally selected folder" })
  for (const changed of [
    { sessionID: "another-session" },
    { projectID: "another-project" },
    { targetRuntimeID: "another-runtime" },
    { bindingEpoch: 8 },
    { controlRevision: 12 },
    { native: null },
    { native: { ...options.native!, reference: { workspaceID: "other-directory", generation: 2, revision: 3 } } },
    { native: { ...options.native!, reference: { workspaceID: "native", generation: 3, revision: 3 } } },
    { native: { ...options.native!, reference: { workspaceID: "native", generation: 2, revision: 4 } } },
    { native: { ...options.native!, projectRevision: "c".repeat(64) } },
  ])
    expect(
      organizationDirectoryFromOptions({ ...input, options: Handoff.Options.parse({ ...options, ...changed }) }),
    ).toBeUndefined()
})

test("a saved directory caption never names a changed handoff, generation, revision or target", () => {
  const directory = { plan, label: "Originally selected folder" }
  expect(organizationDirectoryLabel(directory, view)).toBe(directory.label)
  expect(organizationDirectoryLabel(undefined, view)).toBeUndefined()
  for (const changed of [
    { handoffID: "another-handoff" },
    { targetRuntimeID: "another-runtime" },
    { fromEpoch: 6 },
    { mappingPlanRevision: 2 },
    { workspaceMapping: { ...mapping, moveID: "another-move" } },
    { workspaceMapping: { ...mapping, target: { ...mapping.target, workspaceID: "other-directory" } } },
    { workspaceMapping: { ...mapping, target: { ...mapping.target, generation: 3 } } },
    { workspaceMapping: { ...mapping, target: { ...mapping.target, expectedRevision: 4 } } },
    { workspaceMapping: { ...mapping, target: { ...mapping.target, projectRevision: "c".repeat(64) } } },
  ])
    expect(organizationDirectoryLabel(directory, Handoff.View.parse({ ...view, ...changed }))).toBeUndefined()
})
