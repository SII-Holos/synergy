import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { z } from "zod"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionContextContributions } from "@ericsanchezok/synergy-harness/session/context-contributions"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { SkillTool } from "@ericsanchezok/synergy-local-runtime/tools/skill"
import { OrganizationKnowledgeProtocol as Knowledge } from "@ericsanchezok/synergy-organization-protocol"
import { loadOrganizationKnowledge } from "../src/knowledge-source"
import { createMemberKnowledgeTool } from "../src/tools/knowledge"
import { executionFixture } from "./support/execution"
import { knowledgePage } from "../src/knowledge"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

async function applySelection(
  f: Awaited<ReturnType<typeof executionFixture>>,
  input: { projectID: string; expectedRevision: number; releases: Knowledge.Reference[] },
) {
  const options = { headers: f.headers, throwOnError: true as const }
  const update = (
    await f.client.orgKnowledge.beginSelectionUpdate(
      {
        requestID: crypto.randomUUID(),
        target: { kind: "member", projectID: input.projectID },
        expectedRevision: input.expectedRevision,
      },
      options,
    )
  ).data
  const previous: Knowledge.Reference[] = []
  let cursor: string | undefined
  do {
    const page = (await f.client.orgKnowledge.appliedPage({ projectID: input.projectID, cursor, limit: 100 }, options))
      .data
    previous.push(...page.items)
    cursor = page.cursor
  } while (cursor)
  const selected = new Set(input.releases.map((reference) => reference.itemID))
  const changes = [
    ...previous
      .filter((reference) => !selected.has(reference.itemID))
      .map((reference) => ({ itemID: reference.itemID })),
    ...input.releases.map((reference) => ({ itemID: reference.itemID, reference })),
  ]
  let sequence = 0
  for (let start = 0; start < changes.length; start += 100)
    await f.client.orgKnowledge.patchSelectionUpdate(
      { updateID: update.updateID, sequence: sequence++, changes: changes.slice(start, start + 100) },
      options,
    )
  return (
    await f.client.orgKnowledge.commitSelectionUpdate(
      { updateID: update.updateID, expectedSequence: sequence },
      options,
    )
  ).data
}

async function publish(
  f: Awaited<ReturnType<typeof executionFixture>>,
  projectID: string,
  body: string,
  expectedRevision: number,
) {
  const options = { headers: f.headers, throwOnError: true as const }
  const upload = (
    await f.client.orgPublications.createUpload(
      { requestID: crypto.randomUUID(), purpose: "knowledge", scope: { kind: "project", projectID } },
      options,
    )
  ).data
  const file = (
    await f.client.orgPublications.putFile(
      {
        uploadID: upload.uploadID,
        path: "SKILL.md",
        bytes: Buffer.byteLength(body),
        sha256: hash(body),
        mediaType: "text/markdown",
      },
      options,
    )
  ).data
  await f.client.orgPublications.putChunk(
    { uploadID: upload.uploadID, fileID: file.fileID, offset: 0, body: new Blob([body]) },
    options,
  )
  await f.client.orgPublications.seal(
    { uploadID: upload.uploadID, fileCount: 1, totalBytes: Buffer.byteLength(body) },
    options,
  )
  const release = (
    await f.client.orgKnowledge.publish(
      {
        requestID: crypto.randomUUID(),
        itemID: "team",
        expectedRevision,
        uploadID: upload.uploadID,
        title: "Team",
        kind: "skill",
      },
      options,
    )
  ).data
  const reference = Knowledge.Reference.parse({
    itemID: release.itemID,
    version: release.version,
    manifestHash: release.manifestHash,
  })
  return { release, reference, file }
}

test("signed machine knowledge reads selected versions and fences removed selections", async () => {
  await using f = await executionFixture({ execution: true, knowledge: true })
  const options = { headers: f.headers, throwOnError: true as const }
  const session = await f.runtime.run(() => Session.get(f.sessionID))
  const body = "---\nname: team-work\ndescription: Team work\n---\nSigned selected instructions"
  const { release, reference, file } = await publish(f, session.scope.id, body, 0)
  await applySelection(f, { projectID: session.scope.id, expectedRevision: 0, releases: [reference] })
  const proof = await f.description()
  expect((await f.connection.resources.knowledge(proof)).items).toEqual([release])
  expect((await f.connection.resources.knowledgeFiles(proof, reference)).items).toEqual([file])
  const content = await f.connection.resources.knowledgeContent(proof, reference, file.fileID, 0, 128 * 1024)
  expect(Buffer.from(content.data, "base64url").toString()).toBe(body)
  await expect(f.connection.resources.knowledgeFiles(proof, { ...reference, version: 2 })).rejects.toMatchObject({
    data: { code: "PERMISSION_DENIED" },
  })
  await f.binding()
  await f.runtime.run(() =>
    ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: async () => {
        const active = await loadOrganizationKnowledge(f.member.identity, f.sessionID)
        expect(
          (await knowledgePage(active)).items.map(({ release }) =>
            Knowledge.Reference.parse(Knowledge.Reference.strip().parse(release)),
          ),
        ).toEqual([reference])
        const ctx: Tool.Context = {
          sessionID: f.sessionID,
          messageID: "tool-message",
          agent: "atlas",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        }
        const context = await SessionContextContributions.collect(
          { sessionID: f.sessionID, scopeID: session.scope.id, messages: [], isTopSession: true, signal: ctx.abort },
          "model",
        )
        expect(context?.context).toContain("team-work: Team work [v1]")
        expect((await (await SkillTool.init()).execute({ name: "team-work" }, ctx)).output).toContain(
          "Signed selected instructions",
        )
        const tool = await createMemberKnowledgeTool(f.member.identity).init()
        expect(z.toJSONSchema(tool.parameters).type).toBe("object")
        expect(
          (
            await tool.execute(
              { input: { operation: "read", ...reference, fileID: file.fileID, offset: 0, length: 1024 } },
              ctx,
            )
          ).output,
        ).toContain("Signed selected instructions")
        expect(
          (await tool.execute({ input: { operation: "search", q: "selected instructions" } }, ctx)).output,
        ).toContain("Signed selected instructions")
        await expect(
          tool.execute(
            { input: { operation: "list" } },
            { ...ctx, abort: AbortSignal.abort(new Error("Cancelled knowledge read")) },
          ),
        ).rejects.toThrow("Cancelled knowledge read")
        const second = await publish(
          f,
          session.scope.id,
          body.replace("Signed selected instructions", "Updated selected instructions"),
          1,
        )
        await applySelection(f, { projectID: session.scope.id, expectedRevision: 1, releases: [second.reference] })
        f.interceptHTTP(async (request) => {
          if (!request.url.endsWith("/knowledge/content")) return
          const input = (await request.clone().json()) as { reference?: { version?: number } }
          if (input.reference?.version === 2)
            return Response.json(
              {
                code: "SERVICE_UNAVAILABLE",
                message: "Controlled publication download failure",
                retryable: true,
                outcome: "not_dispatched",
              },
              { status: 503 },
            )
        })
        const retained = await loadOrganizationKnowledge(f.member.identity, f.sessionID)
        expect(
          (await knowledgePage(retained)).items.map(({ release }) =>
            Knowledge.Reference.parse(Knowledge.Reference.strip().parse(release)),
          ),
        ).toEqual([reference])
        expect(retained.updateError).toContain("previous complete version remains active")
        expect((await f.client.orgKnowledge.status({ sessionID: f.sessionID }, options)).data).toMatchObject({
          state: "failed",
          error: "update_failed",
          desired: { manifestHash: hash(JSON.stringify([second.reference])) },
          activated: { manifestHash: hash(JSON.stringify([reference])) },
        })
        expect((await (await SkillTool.init()).execute({ name: "team-work" }, ctx)).output).toContain(
          "Signed selected instructions",
        )
        expect(
          (
            await tool.execute(
              { input: { operation: "read", ...reference, fileID: file.fileID, offset: 0, length: 1024 } },
              ctx,
            )
          ).output,
        ).toContain("Signed selected instructions")
        f.interceptHTTP(undefined)
        expect((await (await SkillTool.init()).execute({ name: "team-work" }, ctx)).output).toContain(
          "Updated selected instructions",
        )
        expect((await f.client.orgKnowledge.status({ sessionID: f.sessionID }, options)).data.state).toBe("active")
        await applySelection(f, { projectID: session.scope.id, expectedRevision: 2, releases: [] })
        const updated = await SessionContextContributions.collect(
          { sessionID: f.sessionID, scopeID: session.scope.id, messages: [], isTopSession: true, signal: ctx.abort },
          "model",
        )
        expect(updated?.context).not.toContain("team-work:")
        await expect(
          tool.execute(
            { input: { operation: "read", ...reference, fileID: file.fileID, offset: 0, length: 1024 } },
            ctx,
          ),
        ).rejects.toThrow()
        await expect((await SkillTool.init()).execute({ name: "team-work" }, ctx)).rejects.toThrow()
      },
    }),
  )
  await expect(
    f.connection.resources.knowledgeContent(await f.description(), reference, file.fileID, 0, 128),
  ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
})
