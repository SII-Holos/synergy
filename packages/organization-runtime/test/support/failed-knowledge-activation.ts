import { expect } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { OrganizationKnowledgeProtocol as Knowledge } from "@ericsanchezok/synergy-organization-protocol"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import type { RuntimeIdentity } from "../../src/home"
import { activeKnowledge, knowledgePage, knowledgeFiles, knowledgeSkills, selectedKnowledge } from "../../src/knowledge"
import { loadOrganizationKnowledge } from "../../src/knowledge-source"
import { OrganizationExecutionLeases } from "../../src/execution-leases"
import type { completedHostedTask } from "./hosted-task"
import { publish } from "./knowledge"
import { captureKnowledgeHistory, verifyFailedKnowledgeHistory } from "./failed-knowledge-history"

type Selected = Parameters<typeof completedHostedTask>[0] & { home: { identity: RuntimeIdentity } }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export async function failedKnowledgeActivation(
  selected: Selected,
  task: Awaited<ReturnType<typeof completedHostedTask>>,
  nonempty = false,
) {
  const options = { headers: selected.service.headers, throwOnError: true as const }
  const calls = task.calls.length
  const beforeUpdate = await captureKnowledgeHistory(selected)
  const load = () =>
    selected.runtime.run(() =>
      ScopeContext.provide({
        scope: task.info.scope,
        workspace: null,
        fn: () => loadOrganizationKnowledge(selected.home.identity, task.sessionID),
      }),
    )
  async function select(reference: Knowledge.Reference, expectedRevision: number, requestID: string) {
    const update = (
      await selected.service.client.orgKnowledge.beginSelectionUpdate(
        { requestID, target: { kind: "session", sessionID: task.sessionID }, expectedRevision },
        options,
      )
    ).data
    await selected.service.client.orgKnowledge.patchSelectionUpdate(
      { updateID: update.updateID, sequence: 0, changes: [{ itemID: reference.itemID, reference }] },
      options,
    )
    return {
      updateID: update.updateID,
      desired: (
        await selected.service.client.orgKnowledge.commitSelectionUpdate(
          { updateID: update.updateID, expectedSequence: 1 },
          options,
        )
      ).data,
    }
  }
  let original:
    | {
        published: Awaited<ReturnType<typeof publish>>
        body: string
        directory: string
        entryFile: string
        cacheRoot: string
      }
    | undefined
  if (nonempty) {
    const body =
      "---\nname: original-retained\ndescription: Original retained Knowledge\n---\nImmutable version A survives a failed desired version B.\n"
    const published = await publish(selected.service, task.target.projectID, body, 0)
    const initial = (await selected.service.client.orgKnowledge.status({ sessionID: task.sessionID }, options)).data
    const { desired } = await select(published.reference, initial.desired.revision, "activate-original-knowledge")
    const activated = await load()
    expect(activated.selection).toEqual(desired)
    expect(activated.selection.releaseCount).toBe(1)
    expect(activated.updateError).toBeUndefined()
    const cached = await selected.runtime.run(() => selectedKnowledge(activated, published.reference.itemID))
    if (!cached) throw new Error("The genuine original activation has no retained cache")
    expect(cached.release).toEqual(published.release)
    const files = await selected.runtime.run(() => knowledgeFiles(activated, published.reference))
    expect(files.items).toEqual([published.file])
    const entryFile = path.join(cached.directory, "SKILL.md")
    const bytes = await Bun.file(entryFile).bytes()
    expect(Buffer.from(bytes).toString()).toBe(body)
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(published.file.sha256)
    const cacheRoot = await selected.runtime.run(() =>
      fs.realpath(path.join(RuntimeContext.current().host.root, "data", "organization-knowledge", "releases")),
    )
    const relative = path.relative(cacheRoot, await fs.realpath(cached.directory))
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
      throw new Error("The actual original cache is outside its task-owned Knowledge directory")
    original = { published, body, directory: cached.directory, entryFile, cacheRoot }
  }
  let originalRemoved = false
  const previous = await selected.runtime.run(() => activeKnowledge(task.sessionID))
  if (!previous) throw new Error("The real completed task has no original activated knowledge manifest")
  expect(previous.selection.releaseCount).toBe(nonempty ? 1 : 0)
  const before = (await selected.service.client.orgKnowledge.status({ sessionID: task.sessionID }, options)).data
  expect(before).toMatchObject({ state: "active", activated: previous.selection })
  expect(before.desired.releaseCount).toBe(nonempty ? 1 : 0)
  const body =
    "---\nname: retained-original\ndescription: Original immutable knowledge\n---\nThe attempted update remains a valid original publication.\n"
  const published = await publish(selected.service, task.target.projectID, body, nonempty ? 1 : 0)
  const attempted = await select(published.reference, before.desired.revision, "failed-native-knowledge-update")
  let desired = attempted.desired
  expect(desired).toMatchObject({ releaseCount: 1, manifestHash: hash([published.reference]) })
  let originalContentFailures = 0
  selected.service.interceptHTTP(async (request) => {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/knowledge/content")) return
    const content = Knowledge.ExecutionContent.parse(await request.clone().json())
    const proof = content.authority.proof
    if (
      proof.runtimeID !== selected.registration.runtimeID ||
      proof.receipt.accepted?.permit.sessionID !== task.sessionID ||
      JSON.stringify(content.reference) !== JSON.stringify(published.reference)
    )
      return
    originalContentFailures++
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
  let retained: Awaited<ReturnType<typeof loadOrganizationKnowledge>>
  try {
    retained = await load()
  } finally {
    selected.service.interceptHTTP(undefined)
  }
  expect(originalContentFailures).toBeGreaterThan(0)
  expect(retained.selection).toEqual(previous.selection)
  expect(retained.updateError).toContain("previous complete version remains active")
  expect(await selected.runtime.run(() => activeKnowledge(task.sessionID))).toEqual(previous)
  let failed = (await selected.service.client.orgKnowledge.status({ sessionID: task.sessionID }, options)).data
  expect(failed).toMatchObject({ state: "failed", error: "update_failed", desired, activated: previous.selection })
  const historical = await verifyFailedKnowledgeHistory({
    selected,
    sessionID: task.sessionID,
    reference: published.reference,
    originalUpdateID: attempted.updateID,
    desired,
    beforeUpdate,
  })
  desired = historical.desired
  failed = historical.failed
  expect(failed.activated).toEqual(previous.selection)
  expect(task.calls).toHaveLength(calls)
  expect(await selected.runtime.run(async () => SessionManager.isRunning(task.sessionID))).toBe(false)
  expect(await selected.runtime.run(() => OrganizationExecutionLeases.pendingForCapture())).toBe(false)
  return {
    failed,
    nonempty,
    async removeOriginalCache() {
      const source = original
      if (!source) throw new Error("Only the nonempty original Knowledge cache can be removed")
      const relative = path.relative(source.cacheRoot, await fs.realpath(source.directory))
      if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
        throw new Error("The original retained cache moved outside its task-owned directory")
      await fs.rm(source.directory, { recursive: true })
      expect(await Bun.file(source.entryFile).exists()).toBe(false)
      originalRemoved = true
    },
    async verify(restored: Selected) {
      const login = await restored.service.client.orgAuth.login(
        {
          orgLoginInput: { loginName: "owner", password: "a long integration password" },
        },
        { throwOnError: true },
      )
      const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
      if (!cookie) throw new Error("The restored knowledge reader lacks its actual current login")
      const headers = { cookie, "x-csrf-token": login.data.csrfToken }
      const current = { headers, throwOnError: true as const }
      expect((await restored.service.client.orgKnowledge.status({ sessionID: task.sessionID }, current)).data).toEqual(
        failed,
      )
      const page = (
        await restored.service.client.orgKnowledge.sessionSelectionPage(
          {
            sessionID: task.sessionID,
            limit: 100,
          },
          current,
        )
      ).data
      expect(page.selection).toEqual(desired)
      expect(page.items).toEqual([published.reference])
      expect(
        (
          await restored.service.client.orgKnowledge.version(
            {
              itemID: published.reference.itemID,
              version: published.reference.version,
            },
            current,
          )
        ).data,
      ).toEqual(published.release)
      expect(
        (
          await restored.service.client.orgKnowledge.files(
            {
              itemID: published.reference.itemID,
              version: published.reference.version,
              limit: 100,
            },
            current,
          )
        ).data.items,
      ).toEqual([published.file])
      const response = await restored.service.service.fetch(
        new Request(
          restored.service.origin +
            `/org/v1/knowledge/${published.reference.itemID}/versions/${published.reference.version}/files/${published.file.fileID}/content`,
          { headers },
        ),
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(body)
      const active = await restored.runtime.run(() => activeKnowledge(task.sessionID))
      expect(active).toEqual(previous)
      if (!active) throw new Error("Restoration lost its original retained active manifest")
      if (!original) expect((await restored.runtime.run(() => knowledgePage(active))).items).toEqual([])
      else {
        const retainedOriginal = original
        expect(originalRemoved).toBe(true)
        expect(await Bun.file(retainedOriginal.entryFile).exists()).toBe(false)
        const page = await restored.runtime.run(() => knowledgePage(active))
        expect(page.items.map((item) => item.release)).toEqual([retainedOriginal.published.release])
        expect(
          (await restored.runtime.run(() => knowledgeFiles(active, retainedOriginal.published.reference))).items,
        ).toEqual([retainedOriginal.published.file])
        const skills = await restored.runtime.run(() => knowledgeSkills(active))
        expect(skills.map((item) => item.release)).toEqual([retainedOriginal.published.release])
        const backing = skills[0]?.info.backing
        if (backing?.kind !== "file") throw new Error("The restored retained Skill has no actual native file")
        const root = await restored.runtime.run(() => fs.realpath(RuntimeContext.current().host.root))
        const relative = path.relative(root, await fs.realpath(backing.baseDir))
        expect(relative.length).toBeGreaterThan(0)
        expect(relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)).toBe(false)
        expect(backing.baseDir).not.toBe(retainedOriginal.directory)
        expect(backing.entryFile).not.toBe(retainedOriginal.entryFile)
        const bytes = await Bun.file(backing.entryFile).bytes()
        expect(Buffer.from(bytes).toString()).toBe(retainedOriginal.body)
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(retainedOriginal.published.file.sha256)
        expect(
          (
            await restored.service.client.orgKnowledge.version(
              {
                itemID: retainedOriginal.published.reference.itemID,
                version: retainedOriginal.published.reference.version,
              },
              current,
            )
          ).data,
        ).toEqual(retainedOriginal.published.release)
      }
      expect(task.calls).toHaveLength(calls)
      expect(await restored.runtime.run(async () => SessionManager.isRunning(task.sessionID))).toBe(false)
    },
  }
}
