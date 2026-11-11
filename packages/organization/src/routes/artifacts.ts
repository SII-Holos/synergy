import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol as Protocol,
  OrganizationArtifactProtocol as Artifact,
  OrganizationPublicationProtocol as Publication,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationArtifacts as Published } from "../artifacts"
import { browserCredentials, operation, validation } from "./shared"

const target = z.strictObject({ artifactID: Identity.ID })
const versionTarget = target.extend({ version: z.coerce.number().int().positive() })
const fileTarget = versionTarget.extend({ fileID: Protocol.Digest })
const projectTarget = z.strictObject({ projectID: Identity.ID })

export function artifactRoutes(publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  return new Hono()
    .post(
      "/artifacts",
      operation("orgArtifacts.publish", "Publish an immutable project artifact version", Artifact.Version, true),
      validator("json", Artifact.Publish, validation),
      async (c) => c.json(await Published.publish(credentials(c), c.req.valid("json"))),
    )
    .get(
      "/projects/:projectID/artifacts",
      operation(
        "orgArtifacts.list",
        "List published artifacts independently of source Session visibility",
        Artifact.Page,
      ),
      validator("param", projectTarget, validation),
      validator("query", Artifact.Query, validation),
      async (c) =>
        c.json(
          await Published.list(credentials(c, "artifacts.read"), c.req.valid("param").projectID, c.req.valid("query")),
        ),
    )
    .get(
      "/artifacts/:artifactID",
      operation("orgArtifacts.get", "Read the latest authorized project artifact", Artifact.Version),
      validator("param", target, validation),
      async (c) => c.json(await Published.get(credentials(c, "artifacts.read"), c.req.valid("param").artifactID)),
    )
    .get(
      "/artifacts/:artifactID/versions",
      operation("orgArtifacts.versions", "Page immutable artifact versions", Artifact.VersionPage),
      validator("param", target, validation),
      validator("query", Artifact.VersionQuery, validation),
      async (c) =>
        c.json(
          await Published.versions(
            credentials(c, "artifacts.read"),
            c.req.valid("param").artifactID,
            c.req.valid("query"),
          ),
        ),
    )
    .get(
      "/artifacts/:artifactID/versions/:version",
      operation("orgArtifacts.version", "Read one immutable artifact version", Artifact.Version),
      validator("param", versionTarget, validation),
      async (c) => {
        const { artifactID, version } = c.req.valid("param")
        return c.json(await Published.get(credentials(c, "artifacts.read"), artifactID, version))
      },
    )
    .get(
      "/artifacts/:artifactID/versions/:version/reference",
      operation("orgArtifacts.reference", "Resolve an authorized versioned artifact reference", Artifact.Reference),
      validator("param", versionTarget, validation),
      validator("query", Publication.PageQuery, validation),
      async (c) => {
        const { artifactID, version } = c.req.valid("param")
        return c.json(
          await Published.reference(credentials(c, "artifacts.read"), artifactID, version, c.req.valid("query")),
        )
      },
    )
    .get(
      "/artifacts/:artifactID/versions/:version/files/:fileID/content",
      describeRoute({
        operationId: "orgArtifacts.content",
        summary: "Download a project artifact after current authorization, including byte ranges",
        responses: {
          200: {
            description: "File bytes",
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
          206: { description: "Authorized file range" },
          416: { description: "Unsatisfiable range" },
        },
      }),
      validator("param", fileTarget, validation),
      async (c) => {
        const { artifactID, version, fileID } = c.req.valid("param")
        return Published.content(
          credentials(c, "artifacts.read"),
          artifactID,
          version,
          fileID,
          c.req.header("range"),
          c.req.raw.signal,
        )
      },
    )
}
