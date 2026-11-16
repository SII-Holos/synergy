import { expect, test } from "bun:test"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import {
  createOrganizationHandoffDifference,
  organizationNativeHandoffMapping,
} from "../../src/organization/handoff-native-state"

const options = Handoff.Options.parse({
  sessionID: "session",
  projectID: "project",
  bindingEpoch: 2,
  controlRevision: 7,
  sourceRuntimeID: "cloud-runtime",
  targetRuntimeID: "member-runtime",
  source: {
    kind: "organization",
    reference: { workspaceID: "cloud", generation: 4, revision: 6 },
    label: "Cloud project",
    resource: { resourceID: "storage", workspaceID: "cloud", generation: 4, path: "project" },
  },
  native: {
    reference: { workspaceID: "local", generation: 3, revision: 5 },
    projectRevision: "a".repeat(64),
    label: "/chosen/project",
  },
  choices: [{ kind: "organization-native", targetKind: "existing", requiresDifference: true }],
})
const summary = Handoff.Difference.parse({
  sourceSnapshotHash: "b".repeat(64),
  targetDigest: "c".repeat(64),
  diffHash: "d".repeat(64),
  mappingPlanRevision: 1,
  entries: 2,
  sourceEntries: 2,
  targetEntries: 2,
  mode: { source: 0o755, target: 0o755 },
})
const row = (path: string) => ({
  path,
  source: null,
  target: { path, kind: "file", size: 1, mode: 0o644, hash: "e".repeat(64) },
})

test("existing-native selection copies actual inspected identities and never invents a directory", () => {
  expect(organizationNativeHandoffMapping(options, "move")).toEqual(
    Handoff.WorkspaceMapping.parse({
      kind: "organization-native",
      moveID: "move",
      source: { workspaceID: "cloud", generation: 4 },
      resource: options.source!.resource,
      target: {
        kind: "existing",
        workspaceID: "local",
        generation: 3,
        expectedRevision: 5,
        projectRevision: "a".repeat(64),
      },
    }),
  )
  expect(organizationNativeHandoffMapping({ ...options, native: null }, "move")).toBeUndefined()
  expect(organizationNativeHandoffMapping({ ...options, choices: [] }, "move")).toBeUndefined()
})

test("a private native download uses its exact cloud source without inventing an existing directory", () => {
  const download = Handoff.Options.parse({
    ...options,
    native: null,
    choices: [{ kind: "organization-native", targetKind: "private-copy", requiresDifference: false }],
  })
  const resource = download.source?.resource
  if (!resource) throw new Error("The download fixture requires its real cloud resource")
  expect(organizationNativeHandoffMapping(download, "download", "private-copy")).toEqual({
    kind: "organization-native",
    moveID: "download",
    source: { workspaceID: "cloud", generation: 4 },
    resource,
    target: { kind: "private-copy" },
  })
  expect(organizationNativeHandoffMapping(download, "download", "existing")).toBeUndefined()
  expect(organizationNativeHandoffMapping(options, "download", "private-copy")).toBeUndefined()
  expect(organizationNativeHandoffMapping({ ...download, choices: [] }, "download", "private-copy")).toBeUndefined()
  expect(organizationNativeHandoffMapping({ ...download, source: null }, "download", "private-copy")).toBeUndefined()
  expect(
    organizationNativeHandoffMapping(
      { ...download, choices: [...download.choices, ...options.choices] },
      "download",
      "private-copy",
    ),
  ).toEqual({
    kind: "organization-native",
    moveID: "download",
    source: { workspaceID: "cloud", generation: 4 },
    resource,
    target: { kind: "private-copy" },
  })
})

test("native consent retains the complete canonical version with an actual first page and rejects changed identities", () => {
  const reader = createOrganizationHandoffDifference(summary)
  expect(() => reader.consent()).toThrow()
  const first = reader.position(0)
  reader.accept(first, summary, { diffHash: summary.diffHash, items: [row("one")], cursor: "actual-next" })
  expect(reader.current.complete).toBe(false)
  expect(reader.consent()).toEqual(Handoff.DifferenceConsent.strip().parse(summary))
  expect(() =>
    reader.accept(
      reader.position(1),
      { ...summary, targetDigest: "f".repeat(64) },
      { diffHash: summary.diffHash, items: [row("two")] },
    ),
  ).toThrow("version")
  reader.accept(reader.position(1), summary, { diffHash: summary.diffHash, items: [row("two")] })
  expect(reader.consent()).toEqual(Handoff.DifferenceConsent.strip().parse(summary))
  reader.accept(first, summary, { diffHash: summary.diffHash, items: [row("one")], cursor: "actual-next" })
  expect(reader.current.page?.items).toHaveLength(1)
  expect(reader.current.complete).toBe(true)
})

test("empty-more, truncated and foreign difference pages cannot enable confirmation", () => {
  const reader = createOrganizationHandoffDifference(summary)
  expect(() =>
    reader.accept(reader.position(0), summary, { diffHash: summary.diffHash, items: [], cursor: "next" }),
  ).toThrow("incomplete")
  expect(() => reader.accept(reader.position(0), summary, { diffHash: summary.diffHash, items: [row("one")] })).toThrow(
    "incomplete",
  )
  expect(() =>
    reader.accept(reader.position(0), summary, { diffHash: "f".repeat(64), items: [row("one"), row("two")] }),
  ).toThrow("another")
  expect(() => reader.consent()).toThrow("complete")
})
