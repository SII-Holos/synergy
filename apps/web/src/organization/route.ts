import { OrganizationIdentity } from "@ericsanchezok/synergy-organization-protocol"
import { SpaceIdentity } from "../context/space-state"

export type OrganizationRoute =
  | { kind: "connect" }
  | { kind: "organization"; identity: Extract<SpaceIdentity, { kind: "organization" }>; projectID?: string }

export function organizationRoute(
  identity: Extract<SpaceIdentity, { kind: "organization" }>,
  projectID?: string,
  prefix = "",
) {
  const value = SpaceIdentity.parse(identity)
  if (value.kind !== "organization") throw new Error("An organization identity is required")
  const base = `${prefix}/organization/${value.orgID}/${value.accountID}/${value.deploymentIncarnation}`
  return projectID ? `${base}/projects/${OrganizationIdentity.ID.parse(projectID)}` : base
}

export function parseOrganizationRoute(path: string, prefix = ""): OrganizationRoute | undefined {
  if (path === `${prefix}/organization/connect`) return { kind: "connect" }
  if (!path.startsWith(`${prefix}/organization/`)) return
  const parts = path.slice(`${prefix}/organization/`.length).split("/")
  if (parts.length !== 3 && (parts.length !== 5 || parts[3] !== "projects")) return
  const parsed = SpaceIdentity.safeParse({
    kind: "organization",
    orgID: parts[0],
    accountID: parts[1],
    deploymentIncarnation: parts[2],
  })
  if (!parsed.success || parsed.data.kind !== "organization") return
  const project = parts.length === 5 ? OrganizationIdentity.ID.safeParse(parts[4]) : undefined
  if (project && !project.success) return
  return { kind: "organization", identity: parsed.data, ...(project?.success ? { projectID: project.data } : {}) }
}
