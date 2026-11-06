import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { objects } from "../../script/acceptance/objects"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"
import { fixtureProvider, fixtureSettings } from "./support"

test("object acceptance verifies real publication rollback, lost acknowledgements and both signed adapters", async () => {
  await using tmp = await tmpdir()
  using provider = fixtureProvider(() => {
    throw new Error("Object protocol acceptance must not invoke a model")
  })
  const settings = await fixtureSettings(tmp.path, provider.url.toString())
  const cases = selectCases("fault-publication-ack,object-protocols")
  const plan = await makePlan({ source: "a".repeat(40), directory: path.join(tmp.path, "run"), cases, inputs: [] })
  await execute(plan, Object.fromEntries(cases.map((scenario) => [scenario.id, objects(settings)])), {
    source: plan.source,
  })
  const outcome = await report(plan)
  if (!outcome.passed)
    for (const scenario of cases) {
      const file = Bun.file(path.join(plan.directory, "cases", scenario.id, "1/failure.json"))
      if (await file.exists()) console.error(await file.text())
    }
  expect(outcome.cases).toEqual(cases.map(({ id }) => ({ id, status: "passed", attempts: 1, errors: [] })))
  expect(outcome.usage.requests).toBe(0)
  const publication = await Bun.file(path.join(plan.directory, "cases/fault-publication-ack/1/physical.json")).json()
  expect(publication.uploadedButUnpublished).toBe(true)
  expect(publication.finalRevision).toBe(2)
  const protocol = await Bun.file(path.join(plan.directory, "cases/object-protocols/1/transport.json")).json()
  for (const kind of ["s3", "oss"]) {
    const requests = protocol.requests.filter((request: { protocol: string }) => request.protocol === kind)
    expect(requests.some((request: { status: number }) => request.status === 403)).toBe(true)
    expect(requests.some((request: { fault: string }) => request.fault === "corrupt")).toBe(true)
    expect(requests.every((request: { signed: boolean }) => request.signed)).toBe(true)
  }
}, 60_000)
