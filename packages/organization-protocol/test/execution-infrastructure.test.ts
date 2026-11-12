import { expect, test } from "bun:test"
import { OrganizationExecutionProtocol as Execution } from "../src/index"

const local = {
  modelResourceID: "model",
  connectionResourceIDs: ["business"],
  infrastructure: { workspace: null, environment: null },
}
const cloud = {
  ...local,
  infrastructure: {
    workspace: { resourceID: "storage", workspaceID: "shared-workspace" },
    environment: { resourceID: "compute", environmentID: "cloud-environment" },
  },
}

test("execution selections require explicit infrastructure without native path or implicit fallback", () => {
  expect(Execution.Selection.safeParse(local).success).toBeTrue()
  expect(Execution.Selection.safeParse(cloud).success).toBeTrue()
  const { infrastructure: _, ...legacy } = local
  for (const value of [
    legacy,
    { ...local, infrastructure: {} },
    { ...local, infrastructure: { workspace: null } },
    { ...local, infrastructure: { environment: null } },
    { ...cloud, infrastructure: { ...cloud.infrastructure, environment: { resourceID: "compute" } } },
    {
      ...cloud,
      infrastructure: { ...cloud.infrastructure, workspace: { ...cloud.infrastructure.workspace, path: "/private" } },
    },
    {
      ...cloud,
      infrastructure: { ...cloud.infrastructure, environment: { resourceID: "model", environmentID: "env" } },
    },
    {
      ...cloud,
      infrastructure: {
        workspace: cloud.infrastructure.workspace,
        environment: { resourceID: "storage", environmentID: "env" },
      },
    },
  ])
    expect(Execution.Selection.safeParse(value).success).toBeFalse()
})

test("resource accounting includes infrastructure while gateway resources retain explicit business roles", () => {
  const selection = Execution.Selection.parse(cloud)
  expect(Execution.resourceIDs(selection)).toEqual(["model", "business", "storage", "compute"])
  expect(Execution.callResourceIDs(selection)).toEqual(["model", "business"])
  expect(Execution.resourceRoles(selection)).toEqual([
    { resourceID: "model", kind: "model" },
    { resourceID: "business", kind: "connection" },
    { resourceID: "storage", kind: "workspace" },
    { resourceID: "compute", kind: "environment" },
  ])
})
