import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { z } from "zod"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionContextContributions } from "@ericsanchezok/synergy-harness/session/context-contributions"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { SkillTool } from "@ericsanchezok/synergy-local-runtime/tools/skill"
import { OrganizationKnowledgeProtocol as Knowledge } from "@ericsanchezok/synergy-organization-protocol"
import { loadOrganizationKnowledge } from "../src/knowledge-source"
import { createMemberKnowledgeTool } from "../src/tools/knowledge"
import { executionFixture } from "./support/execution"
import { activeKnowledge, knowledgePage } from "../src/knowledge"
import { applySelection, publish } from "./support/knowledge"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

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
          agent: PrimaryAgentIdentity.names.general,
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

test("an applied Skill update preserves the authorized load awaiting permission and rechecks withdrawal", async () => {
  await using f = await executionFixture({ execution: true, knowledge: true })
  const options = { headers: f.headers, throwOnError: true as const }
  const session = await f.runtime.run(() => Session.get(f.sessionID))
  const firstContent = "Original authorized instructions"
  const secondContent = "Explicitly updated instructions"
  const skill = (content: string) => `---\nname: team-work\ndescription: Team work\n---\n${content}`
  const first = await publish(f, session.scope.id, skill(firstContent), 0)
  await applySelection(f, { projectID: session.scope.id, expectedRevision: 0, releases: [first.reference] })
  const second = await publish(f, session.scope.id, skill(secondContent), 1)
  await f.binding()
  await f.runtime.run(() =>
    ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: async () => {
        const captured: Array<{ content: string; sha256: string; provenance: Knowledge.Reference }> = []
        const awaitingPermission = Promise.withResolvers<void>()
        const permitted = Promise.withResolvers<void>()
        let firstPermission = true
        const ctx: Tool.Context = {
          sessionID: f.sessionID,
          messageID: "knowledge-boundary-tool",
          agent: PrimaryAgentIdentity.names.general,
          abort: new AbortController().signal,
          metadata() {},
          async ask() {
            if (!firstPermission) return
            firstPermission = false
            awaitingPermission.resolve()
            await permitted.promise
          },
          async captureResult(value) {
            const evidence = z
              .object({ content: z.string(), sha256: z.string(), provenance: Knowledge.Reference })
              .safeParse(value)
            if (evidence.success) captured.push(evidence.data)
            else
              z.object({ title: z.string(), output: z.string(), metadata: z.record(z.string(), z.unknown()) }).parse(
                value,
              )
          },
        }
        const tool = await SkillTool.init()
        const pending = tool.execute({ name: "team-work" }, ctx)
        try {
          await awaitingPermission.promise
          expect((await f.client.orgKnowledge.status({ sessionID: f.sessionID }, options)).data).toMatchObject({
            state: "active",
            activated: { manifestHash: hash(JSON.stringify([first.reference])) },
          })
          await applySelection(f, {
            projectID: session.scope.id,
            expectedRevision: 1,
            releases: [second.reference],
          })
          const overlapping = await tool.execute({ name: "team-work" }, ctx)
          expect(overlapping.output).toContain(secondContent)
          expect(captured).toHaveLength(1)
          expect(captured[0]?.provenance).toEqual(second.reference)
          permitted.resolve()
          const original = await pending
          expect(original.output).toContain(firstContent)
          expect(original.output).not.toContain(secondContent)
          expect(captured).toHaveLength(2)
          const originalEvidence = captured[1]
          if (!originalEvidence) throw new Error("The original Skill load did not record its content")
          expect(originalEvidence.content.trim()).toBe(firstContent)
          expect(originalEvidence.sha256).toBe(hash(originalEvidence.content))
          expect(originalEvidence.provenance).toEqual(first.reference)
          expect((await activeKnowledge(f.sessionID))?.selection.manifestHash).toBe(
            hash(JSON.stringify([second.reference])),
          )

          const next = await tool.execute({ name: "team-work" }, ctx)
          expect(next.output).toContain(secondContent)
          expect(next.output).not.toContain(firstContent)
          expect(captured).toHaveLength(3)
          const nextEvidence = captured[2]
          if (!nextEvidence) throw new Error("The updated Skill load did not record its content")
          expect(nextEvidence.content.trim()).toBe(secondContent)
          expect(nextEvidence.sha256).toBe(hash(nextEvidence.content))
          expect(nextEvidence.provenance).toEqual(second.reference)

          const catalog = (await f.client.orgKnowledge.list({ projectID: session.scope.id, limit: 100 }, options)).data
          const current = catalog.items.find((item) => item.itemID === second.reference.itemID)
          if (!current) throw new Error("The published Skill is missing from its authorized catalog")
          await expect(
            tool.execute(
              { name: "team-work" },
              {
                ...ctx,
                async ask() {
                  await f.client.orgKnowledge.withdraw(
                    { itemID: current.itemID, expectedRevision: current.revision },
                    options,
                  )
                },
              },
            ),
          ).rejects.toThrow()
          expect(captured).toHaveLength(3)
          expect(
            (
              await f.client.orgKnowledge.appliedReferences(
                { projectID: session.scope.id, itemIDs: [second.reference.itemID] },
                options,
              )
            ).data.items,
          ).toEqual([second.reference])
          await expect(
            f.connection.resources.knowledgeContent(
              await f.description(),
              second.reference,
              second.file.fileID,
              0,
              1024,
            ),
          ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
        } finally {
          permitted.resolve()
          await pending.catch(() => {})
        }
      },
    }),
  )
})
