import { OrganizationIdentity } from "@ericsanchezok/synergy-organization-protocol"
import { SpaceIdentity } from "../context/space-state"

export type OrganizationRoute =
  | { kind: "connect" }
  | {
      kind: "organization"
      identity: Extract<SpaceIdentity, { kind: "organization" }>
      projectID?: string
      view?: OrganizationView
      sessionID?: string
    }

const views = ["sessions", "members", "resources", "knowledge", "artifacts", "settings", "account"] as const
export type OrganizationView = (typeof views)[number]

export function organizationRoute(
  identity: Extract<SpaceIdentity, { kind: "organization" }>,
  projectID?: string,
  prefix = "",
  view?: OrganizationView,
  sessionID?: string,
) {
  const value = SpaceIdentity.parse(identity)
  if (value.kind !== "organization") throw new Error("An organization identity is required")
  const base = `${prefix}/organization/${value.orgID}/${value.accountID}/${value.deploymentIncarnation}`
  const project = projectID ? `${base}/projects/${OrganizationIdentity.ID.parse(projectID)}` : base
  if (sessionID) {
    if (!projectID || view !== "sessions") throw new Error("A conversation requires its project")
    return `${project}/sessions/${OrganizationIdentity.ID.parse(sessionID)}`
  }
  return view ? `${project}/${view}` : project
}

export function parseOrganizationRoute(path: string, prefix = ""): OrganizationRoute | undefined {
  if (path === `${prefix}/organization/connect`) return { kind: "connect" }
  if (!path.startsWith(`${prefix}/organization/`)) return
  const parts = path.slice(`${prefix}/organization/`.length).split("/")
  if (parts.length < 3 || parts.length > 7) return
  const parsed = SpaceIdentity.safeParse({
    kind: "organization",
    orgID: parts[0],
    accountID: parts[1],
    deploymentIncarnation: parts[2],
  })
  if (!parsed.success || parsed.data.kind !== "organization") return
  const hasProject = parts[3] === "projects"
  const project = hasProject ? OrganizationIdentity.ID.safeParse(parts[4]) : undefined
  if (project && !project.success) return
  const view = parts[hasProject ? 5 : 3]
  if (view && !views.some((candidate) => candidate === view)) return
  if ((!hasProject && parts.length > 4) || (hasProject && parts.length === 4)) return
  const session = parts.length === 7 ? OrganizationIdentity.ID.safeParse(parts[6]) : undefined
  if (session && (!session.success || view !== "sessions")) return
  return {
    kind: "organization",
    identity: parsed.data,
    ...(project?.success ? { projectID: project.data } : {}),
    ...(view ? { view: view as OrganizationView } : {}),
    ...(session?.success ? { sessionID: session.data } : {}),
  }
}
