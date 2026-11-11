import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol as Protocol,
  OrganizationKnowledgeProtocol as Knowledge,
  OrganizationPublicationProtocol as Publication,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationKnowledge as Published } from "../knowledge"
import { browserCredentials, operation, validation } from "./shared"

const target = z.strictObject({ itemID: Identity.ID })
const versionTarget = target.extend({ version: z.coerce.number().int().positive() })
const fileTarget = versionTarget.extend({ fileID: Protocol.Digest })
const projectTarget = z.strictObject({ projectID: Identity.ID })
const sessionTarget = z.strictObject({ sessionID: Identity.ID })

export function knowledgeRoutes(publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  return new Hono()
    .get(
      "/knowledge",
      operation("orgKnowledge.list", "List authorized published materials and Skills", Knowledge.Page),
      validator("query", Knowledge.Query, validation),
      async (c) => c.json(await Published.list(credentials(c), c.req.valid("query"))),
    )
    .get(
      "/knowledge/search",
      operation(
        "orgKnowledge.search",
        "Search authorized knowledge before returning any matching content",
        Knowledge.Page,
      ),
      validator("query", Knowledge.Search, validation),
      async (c) => c.json(await Published.search(credentials(c), c.req.valid("query"), c.req.raw.signal)),
    )
    .post(
      "/knowledge",
      operation("orgKnowledge.publish", "Publish an immutable material or Skill version", Knowledge.Release, true),
      validator("json", Knowledge.Publish, validation),
      async (c) => c.json(await Published.publish(credentials(c), c.req.valid("json"))),
    )
    .get(
      "/knowledge/:itemID",
      operation("orgKnowledge.get", "Read the latest authorized knowledge version", Knowledge.Release),
      validator("param", target, validation),
      async (c) => c.json(await Published.get(credentials(c), c.req.valid("param").itemID)),
    )
    .get(
      "/knowledge/:itemID/versions",
      operation("orgKnowledge.versions", "Page immutable knowledge versions", Knowledge.VersionPage),
      validator("param", target, validation),
      validator("query", Knowledge.VersionQuery, validation),
      async (c) => c.json(await Published.versions(credentials(c), c.req.valid("param").itemID, c.req.valid("query"))),
    )
    .get(
      "/knowledge/:itemID/versions/:version",
      operation("orgKnowledge.version", "Resolve an exact knowledge version", Knowledge.Release),
      validator("param", versionTarget, validation),
      async (c) => {
        const { itemID, version } = c.req.valid("param")
        return c.json(await Published.get(credentials(c), itemID, version))
      },
    )
    .get(
      "/knowledge/:itemID/versions/:version/files",
      operation("orgKnowledge.files", "Page files in an exact knowledge release", Publication.FilePage),
      validator("param", versionTarget, validation),
      validator("query", Publication.PageQuery, validation),
      async (c) => {
        const { itemID, version } = c.req.valid("param")
        return c.json(await Published.files(credentials(c), itemID, version, c.req.valid("query")))
      },
    )
    .get(
      "/knowledge/:itemID/versions/:version/files/:fileID/content",
      describeRoute({
        operationId: "orgKnowledge.content",
        summary: "Download an authorized immutable knowledge file",
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
        const { itemID, version, fileID } = c.req.valid("param")
        return Published.content(credentials(c), itemID, version, fileID, c.req.header("range"), c.req.raw.signal)
      },
    )
    .delete(
      "/knowledge/:itemID",
      operation(
        "orgKnowledge.withdraw",
        "Withdraw a catalog entry while retaining referenced historical bytes",
        Knowledge.Item,
        true,
      ),
      validator("param", target, validation),
      validator("json", Knowledge.Withdraw, validation),
      async (c) =>
        c.json(
          await Published.withdraw(credentials(c), c.req.valid("param").itemID, c.req.valid("json").expectedRevision),
        ),
    )
    .get(
      "/projects/:projectID/knowledge/applied",
      operation("orgKnowledge.applied", "Read this member's explicitly applied project versions", Knowledge.Selection),
      validator("param", projectTarget, validation),
      async (c) => c.json(await Published.applied(credentials(c), c.req.valid("param").projectID)),
    )
    .put(
      "/projects/:projectID/knowledge/applied",
      operation(
        "orgKnowledge.apply",
        "Atomically select the complete member knowledge manifest",
        Knowledge.Selection,
        true,
      ),
      validator("param", projectTarget, validation),
      validator("json", Knowledge.Apply, validation),
      async (c) => c.json(await Published.apply(credentials(c), c.req.valid("param").projectID, c.req.valid("json"))),
    )
    .get(
      "/sessions/:sessionID/knowledge",
      operation(
        "orgKnowledge.sessionSelection",
        "Read one Session's independent knowledge versions",
        Knowledge.Selection,
      ),
      validator("param", sessionTarget, validation),
      async (c) => c.json(await Published.sessionSelection(credentials(c), c.req.valid("param").sessionID)),
    )
    .get(
      "/sessions/:sessionID/knowledge/status",
      operation(
        "orgKnowledge.status",
        "Read desired and activated knowledge summaries without material contents",
        Knowledge.Status,
      ),
      validator("param", sessionTarget, validation),
      async (c) => c.json(await Published.status(credentials(c), c.req.valid("param").sessionID)),
    )
    .put(
      "/sessions/:sessionID/knowledge",
      operation(
        "orgKnowledge.setSessionSelection",
        "Explicitly update one Session's knowledge versions",
        Knowledge.Selection,
        true,
      ),
      validator("param", sessionTarget, validation),
      validator("json", Knowledge.Apply, validation),
      async (c) =>
        c.json(
          await Published.setSessionSelection(credentials(c), c.req.valid("param").sessionID, c.req.valid("json")),
        ),
    )
}
