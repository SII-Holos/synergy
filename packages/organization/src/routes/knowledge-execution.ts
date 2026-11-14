import { Hono } from "hono"
import { validator } from "hono-openapi"
import {
  OrganizationKnowledgeProtocol as Knowledge,
  OrganizationPublicationProtocol as Publication,
} from "@ericsanchezok/synergy-organization-protocol"
import type { ExecutionGrants } from "../execution-grants"
import { OrganizationKnowledge as Published } from "../knowledge"
import { fail } from "../error"
import { operation, validation } from "./shared"

export function knowledgeExecutionRoutes(grants: () => ExecutionGrants) {
  return new Hono()
    .use("/knowledge/*", async (c, next) => {
      if (c.req.header("origin") || c.req.header("cookie"))
        fail("PERMISSION_DENIED", "Knowledge execution requires a machine proof")
      await next()
    })
    .post(
      "/knowledge/selection",
      operation(
        "orgKnowledgeExecution.selection",
        "Read the versions selected by accepted Session work",
        Knowledge.ExecutionPage,
        true,
      ),
      validator("json", Knowledge.ExecutionQuery, validation),
      async (c) => {
        const { authority, ...query } = c.req.valid("json")
        const { grant } = await grants().describe(authority)
        return c.json(await Published.executionPage(grant, query))
      },
    )
    .post(
      "/knowledge/files",
      operation(
        "orgKnowledgeExecution.files",
        "Page files in a selected immutable knowledge version",
        Publication.FilePage,
        true,
      ),
      validator("json", Knowledge.ExecutionFiles, validation),
      async (c) => {
        const { authority, reference, activatedManifestHash, ...query } = c.req.valid("json")
        const { grant } = await grants().describe(authority)
        return c.json(await Published.executionFiles(grant, reference, query, activatedManifestHash))
      },
    )
    .post(
      "/knowledge/content",
      operation(
        "orgKnowledgeExecution.content",
        "Read a bounded verified slice of selected knowledge",
        Knowledge.ContentChunk,
        true,
      ),
      validator("json", Knowledge.ExecutionContent, validation),
      async (c) => {
        const { authority, reference, fileID, offset, length, activatedManifestHash } = c.req.valid("json")
        const { grant } = await grants().describe(authority)
        return c.json(await Published.executionContent(grant, reference, fileID, offset, length, activatedManifestHash))
      },
    )
    .post(
      "/knowledge/activate",
      operation(
        "orgKnowledgeExecution.activate",
        "Acknowledge a complete locally activated knowledge manifest",
        Knowledge.ActivationReceipt,
        true,
      ),
      validator("json", Knowledge.ActivationRequest, validation),
      async (c) => {
        const { authority, ...selection } = c.req.valid("json")
        const { grant } = await grants().describe(authority)
        return c.json(await Published.activate(grant, selection))
      },
    )
    .post(
      "/knowledge/activated",
      operation(
        "orgKnowledgeExecution.activated",
        "Reauthorize an exact previously activated manifest after a failed update",
        Knowledge.ExecutionPage,
        true,
      ),
      validator("json", Knowledge.ActivatedQuery, validation),
      async (c) => {
        const { authority, ...query } = c.req.valid("json")
        const { grant } = await grants().describe(authority)
        return c.json(await Published.activated(grant, query))
      },
    )
}
