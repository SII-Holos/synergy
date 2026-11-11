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

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

test("signed machine knowledge reads selected versions and fences removed selections", async () => {
  await using f = await executionFixture({ execution: true, knowledge: true })
  const options = { headers: f.headers, throwOnError: true as const }
  const session = await f.runtime.run(() => Session.get(f.sessionID))
  const upload = (
    await f.client.orgPublications.createUpload(
      { requestID: "skill-upload", purpose: "knowledge", scope: { kind: "project", projectID: session.scope.id } },
      options,
    )
  ).data
  const body = "---\nname: team-work\ndescription: Team work\n---\nSigned selected instructions"
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
        requestID: "publish-skill",
        itemID: "team",
        expectedRevision: 0,
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
  await f.client.orgKnowledge.setSessionSelection(
    { sessionID: f.sessionID, expectedRevision: 0, releases: [reference] },
    options,
  )
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
        expect(active.selection.releases).toEqual([reference])
        const ctx: Tool.Context = {
          sessionID: f.sessionID,
          messageID: "tool-message",
          agent: "atlas",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        }
      const context = await SessionContextContributions.collect({ sessionID: f.sessionID, scopeID: session.scope.id, messages: [], isTopSession: true, signal: ctx.abort }, "model")
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
        await f.client.orgKnowledge.setSessionSelection(
          { sessionID: f.sessionID, expectedRevision: 1, releases: [] },
          options,
        )
      const updated = await SessionContextContributions.collect({ sessionID: f.sessionID, scopeID: session.scope.id, messages: [], isTopSession: true, signal: ctx.abort }, "model")
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
