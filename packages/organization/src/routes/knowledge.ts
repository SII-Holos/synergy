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
const updateTarget = z.strictObject({ updateID: Identity.ID })

export function knowledgeRoutes(publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  return new Hono()
    .post(
      "/knowledge/publication-receipts",
      operation(
        "orgKnowledge.publicationReceipt",
        "Read the exact original publication receipt without publishing",
        Knowledge.PublicationReceipt,
        true,
      ),
      validator("json", Knowledge.Publish, validation),
      async (c) => c.json(await Published.publicationReceipt(credentials(c), c.req.valid("json"))),
    )
    .post(
      "/knowledge/selection-updates",
      operation(
        "orgKnowledge.beginSelectionUpdate",
        "Stage an explicit update over the complete current knowledge manifest",
        Knowledge.SelectionUpdate,
        true,
      ),
      validator("json", Knowledge.BeginSelectionUpdate, validation),
      async (c) => c.json(await Published.beginSelectionUpdate(credentials(c), c.req.valid("json"))),
    )
    .get(
      "/knowledge/selection-updates/:updateID",
      operation(
        "orgKnowledge.selectionUpdate",
        "Inspect a knowledge update after interruption or an unknown response",
        Knowledge.SelectionUpdate,
      ),
      validator("param", updateTarget, validation),
      async (c) => c.json(await Published.selectionUpdate(credentials(c), c.req.valid("param").updateID)),
    )
    .post(
      "/knowledge/selection-updates/:updateID/pages",
      operation(
        "orgKnowledge.patchSelectionUpdate",
        "Apply one immutable retryable page of explicit knowledge changes",
        Knowledge.SelectionUpdate,
        true,
      ),
      validator("param", updateTarget, validation),
      validator("json", Knowledge.PatchSelectionUpdate, validation),
      async (c) =>
        c.json(
          await Published.patchSelectionUpdate(credentials(c), c.req.valid("param").updateID, c.req.valid("json")),
        ),
    )
    .post(
      "/knowledge/selection-updates/:updateID/commit",
      operation(
        "orgKnowledge.commitSelectionUpdate",
        "Reauthorize and atomically publish the complete staged knowledge manifest",
        Knowledge.SelectionSummary,
        true,
      ),
      validator("param", updateTarget, validation),
      validator("json", Knowledge.CommitSelectionUpdate, validation),
      async (c) =>
        c.json(
          await Published.commitSelectionUpdate(credentials(c), c.req.valid("param").updateID, c.req.valid("json")),
        ),
    )
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
      "/projects/:projectID/knowledge/applied/releases",
      operation(
        "orgKnowledge.appliedPage",
        "Page this member's exact applied references without loading the whole manifest",
        Knowledge.SelectionPage,
      ),
      validator("param", projectTarget, validation),
      validator("query", Knowledge.SelectionPageQuery, validation),
      async (c) =>
        c.json(await Published.appliedPage(credentials(c), c.req.valid("param").projectID, c.req.valid("query"))),
    )
    .post(
      "/projects/:projectID/knowledge/applied/references",
      operation(
        "orgKnowledge.appliedReferences",
        "Read applied references for the visible catalog window",
        Knowledge.SelectionPage,
        true,
      ),
      validator("param", projectTarget, validation),
      validator("json", Knowledge.SelectionReferences, validation),
      async (c) =>
        c.json(await Published.appliedReferences(credentials(c), c.req.valid("param").projectID, c.req.valid("json"))),
    )
    .get(
      "/sessions/:sessionID/knowledge/releases",
      operation(
        "orgKnowledge.sessionSelectionPage",
        "Page the executing Session's exact desired knowledge references",
        Knowledge.SelectionPage,
      ),
      validator("param", sessionTarget, validation),
      validator("query", Knowledge.SelectionPageQuery, validation),
      async (c) =>
        c.json(
          await Published.sessionSelectionPage(credentials(c), c.req.valid("param").sessionID, c.req.valid("query")),
        ),
    )
    .post(
      "/sessions/:sessionID/knowledge/references",
      operation(
        "orgKnowledge.sessionSelectionReferences",
        "Read executing Session knowledge references for the visible catalog window",
        Knowledge.SelectionPage,
        true,
      ),
      validator("param", sessionTarget, validation),
      validator("json", Knowledge.SelectionReferences, validation),
      async (c) =>
        c.json(
          await Published.sessionSelectionReferences(
            credentials(c),
            c.req.valid("param").sessionID,
            c.req.valid("json"),
          ),
        ),
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
}
