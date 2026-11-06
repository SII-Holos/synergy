import { expect, test } from "bun:test"
import { createSettingsDomainSave } from "../../../src/components/settings/settings-domain-save"

test("partial domain writes reconcile successful fields and retain failed domains", async () => {
  const written: string[] = []
  const reconciled: Record<string, unknown>[] = []
  let fail = true
  const save = createSettingsDomainSave(
    async (domain, config) => {
      written.push(domain)
      if (domain === "models" && fail) throw new Error("unavailable")
      return { config, changedFields: Object.keys(config) }
    },
    async (receipt) => {
      reconciled.push(receipt.config)
    },
  )
  const result = await save.save(
    new Map([
      ["general", { username: "Ada" }],
      ["models", { model: "p/m" }],
    ]),
  )
  expect(result.failed.map((entry) => entry.domain)).toEqual(["models"])
  expect(reconciled).toEqual([{ username: "Ada" }])
  fail = false
  await save.save(new Map([["models", { model: "p/m" }]]))
  expect(written).toEqual(["general", "models", "models"])
})

test("a persisted write with a failed refresh retries only the read before accepting another write", async () => {
  let writes = 0
  let reads = 0
  const save = createSettingsDomainSave(
    async (_domain, config) => {
      writes++
      return { config, changedFields: Object.keys(config) }
    },
    async () => {
      reads++
      if (reads === 1) throw new Error("read failed")
    },
  )
  const result = await save.save(new Map([["voice", { voice: { tts: { model: "tts-1" } } }]]))
  expect(result.results.map(({ phase }) => phase)).toEqual(["refresh"])
  expect(result.failed).toEqual([])
  expect(save.pending()).toBe(true)
  await save.reconcile()
  expect(save.pending()).toBe(false)
  expect({ writes, reads }).toEqual({ writes: 1, reads: 2 })
})

test("partial writes retain domain outcomes even when the successful write cannot be refreshed", async () => {
  const writer = createSettingsDomainSave(
    async (domain, config) => {
      if (domain === "models") throw new Error("write refused")
      return { config, changedFields: Object.keys(config) }
    },
    async () => {
      throw new Error("read unavailable")
    },
  )
  const result = await writer.save(
    new Map([
      ["general", { username: "Ada" }],
      ["models", { model: "p/m" }],
    ]),
  )
  expect(result.results.map(({ domain, phase }) => ({ domain, phase }))).toEqual([
    { domain: "general", phase: "refresh" },
    { domain: "models", phase: "write" },
  ])
  expect(writer.pending()).toBe(true)
})
