import { expect, spyOn, test } from "bun:test"
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
import { prepareStep, representatives, representativesCurrent, stopPreparation, useCorpus } from "../src/preparation"

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

test("first use reconciles history changed while the component was dormant", async () => {
  await using home = await tmpdir()
  let changed!: Session.Info
  let unchanged!: Session.Info
  for (let phase = 0; phase < 3; phase++) {
    const runtime = await testRuntime({ home: home.path, register: digitalTwin().register })
    try {
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            await UpgradeWork.control("resume")
            if (phase === 0) {
              changed = await Session.create({})
              unchanged = await Session.create({})
              await utterance(changed.id, "检查原来的 API")
              await utterance(unchanged.id, "保持这个边界")
              for (const session of [changed, unchanged])
                while (!(await prepareStep({ scopeID: session.scope.id, sessionID: session.id }))) {}
              await Storage.write(StoragePath.digitalTwinCursor(), { version: 2, complete: true })
            } else if (phase === 1) {
              await utterance(changed.id, "补一下新的异常路径")
              const added = await Session.create({})
              await utterance(added.id, "先测试新的 API")
            } else {
              useCorpus({ scopeID: unchanged.scope.id, sessionID: unchanged.id })
              const deadline = Date.now() + 5000
              while (Date.now() < deadline) {
                if ((await representatives()).statistics.reduce((sum, value) => sum + value.count, 0) === 4) break
                await Bun.sleep(20)
              }
              const result = await representatives()
              expect(result.statistics).toHaveLength(3)
              expect(result.statistics.reduce((sum, value) => sum + value.count, 0)).toBe(4)
            }
          },
        }),
      )
    } finally {
      await runtime.run(stopPreparation)
      await runtime.close()
    }
  }
}, 15000)

test("representative statistics include every prepared family and warm reads reuse the projection cache", async () => {
  const runtime = await testRuntime({ register: digitalTwin().register })
  try {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          await UpgradeWork.control("resume")
          for (let index = 0; index < 130; index++) {
            const session = await Session.create({})
            await utterance(session.id, `第 ${index} 个 API 的边界要清晰`)
            while (!(await prepareStep({ scopeID: session.scope.id, sessionID: session.id }))) {}
          }
          const bundle = await representatives()
          expect(bundle.statistics.reduce((sum, value) => sum + value.count, 0)).toBe(130)
          expect(new Set(bundle.references.map((ref) => ref.family)).size).toBeGreaterThan(4)
          expect(bundle.references.length).toBeLessThanOrEqual(96)
          await runtime.run(stopPreparation)
          using reads = spyOn(Storage, "query")
          expect((await representatives()).statistics).toEqual(bundle.statistics)
          expect(reads).not.toHaveBeenCalled()
          expect(representativesCurrent(bundle)).toBe(true)
        },
      }),
    )
  } finally {
    await runtime.run(stopPreparation)
    await runtime.close()
  }
}, 20_000)

test("cold projection loading honors the background pause gate", async () => {
  const runtime = await testRuntime({ register: digitalTwin().register })
  try {
    await runtime.run(async () => {
      await UpgradeWork.control("pause")
      using reads = spyOn(Storage, "query")
      expect((await representatives()).references).toEqual([])
      await Bun.sleep(80)
      expect(reads).not.toHaveBeenCalled()
      await UpgradeWork.control("resume")
      const deadline = Date.now() + 3000
      while (!reads.mock.calls.length && Date.now() < deadline) await Bun.sleep(20)
      expect(reads).toHaveBeenCalled()
    })
  } finally {
    await runtime.run(stopPreparation)
    await runtime.close()
  }
})

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
            version: 2,
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
          expect(representativesCurrent(projection)).toBe(false)
          while (!representativesCurrent(await representatives())) await Bun.sleep(20)
          const after = await representatives()
          expect(after.references.every((reference) => reference.sessionID === parent.id)).toBe(true)
          expect(after.statistics.reduce((sum, value) => sum + value.count, 0)).toBe(2)
          await Session.remove(parent.id)
          while (!representativesCurrent(await representatives())) await Bun.sleep(20)
          expect((await representatives()).references).toEqual([])
        },
      }),
    )
  } finally {
    await runtime.run(stopPreparation)
    await runtime.close()
  }
}, 15000)
