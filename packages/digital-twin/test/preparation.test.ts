import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { UpgradeWork } from "@ericsanchezok/synergy-harness/storage/upgrade-work"
import { digitalTwin } from "../src/component"
import { prepareStep, representatives, stopPreparation, useCorpus } from "../src/preparation"

async function utterance(sessionID: string, text: string) {
  const id = Identifier.ascending("message")
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    origin: { type: "user" },
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
  })
  return Session.updatePart({ id: Identifier.ascending("part"), sessionID, messageID: id, type: "text", text })
}

test("preparation resumes a final pending page across runtimes, deduplicates families and invalidates deleted sources", async () => {
  await using home = await tmpdir()
  let runtime = await testRuntime({ home: home.path, register: digitalTwin().register })
  let parent!: Session.Info
  let child!: Session.Info
  try {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          await UpgradeWork.control("resume")
          parent = await Session.create({})
          await utterance(parent.id, "先检查边界，再实现 API")
          await utterance(parent.id, "别加冗余代码")
          child = await Session.create({ forkedFrom: { sessionID: parent.id, title: parent.title } })
          await utterance(child.id, "先检查边界，再实现 API")
          await utterance(child.id, "先检查边界，再实现 API！")
          await utterance(child.id, "别加冗余代码")
          await utterance(child.id, "补一下异常路径测试")
          expect(await representatives()).toMatchObject({ references: [], statistics: [] })
          expect(await prepareStep({ scopeID: parent.scope.id, sessionID: parent.id })).toBe(false)
          await Storage.write(StoragePath.digitalTwinCursor(), {
            version: 1,
            complete: true,
            pending: [{ scopeID: child.scope.id, sessionID: child.id }],
          })
        },
      }),
    )
  } finally {
    await runtime.run(stopPreparation)
    await runtime.close()
  }
  runtime = await testRuntime({ home: home.path, register: digitalTwin().register })
  try {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          await UpgradeWork.control("resume")
          useCorpus({ scopeID: parent.scope.id, sessionID: parent.id })
          const deadline = Date.now() + 5000
          while (Date.now() < deadline) {
            const [cursor] = await Storage.readMany<{ pending?: unknown[] }>([StoragePath.digitalTwinCursor()])
            if (!cursor?.pending?.length && (await representatives()).statistics.length) break
            await Bun.sleep(20)
          }
          const projection = await representatives()
          expect(projection.statistics.reduce((sum, value) => sum + value.count, 0)).toBe(3)
          expect(new Set(projection.references.map((reference) => reference.family))).toEqual(new Set([parent.id]))
          await Session.remove(child.id)
          const after = await representatives()
          expect(after.references.every((reference) => reference.sessionID === parent.id)).toBe(true)
          expect(after.statistics.reduce((sum, value) => sum + value.count, 0)).toBe(2)
          await Session.remove(parent.id)
          expect((await representatives()).references).toEqual([])
        },
      }),
    )
  } finally {
    await runtime.run(stopPreparation)
    await runtime.close()
  }
}, 15000)
