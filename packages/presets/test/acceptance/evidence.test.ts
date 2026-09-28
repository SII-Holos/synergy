import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { digest, sealEvidence, verifyResult, type AcceptanceCase, type Result } from "../../script/acceptance/evidence"

const scenario: AcceptanceCase = {
  id: "once",
  units: ["D", "E"],
  risk: "Lost response duplicates an effect",
  preconditions: ["Isolated execution host"],
  actions: ["Append once, lose reply, reconcile"],
  fault: "After the append, before acknowledgement",
  expected: ["One append and recovered result"],
  verification: "Read physical counter and durable operation independently",
  live: true,
  agent: "synergy",
  barriers: ["effect-written", "reply-lost", "recovered"],
  factors: ["remote", "lost-response", "retry"],
  checks: [
    { evidence: "product.json", pointer: ["status"], equals: "completed" },
    { evidence: "counter.txt", sha256: digest("effect\n") },
    { evidence: "transport.json", pointer: ["requests"], minimum: 1 },
  ],
}

async function fixture(root: string) {
  await Bun.write(path.join(root, "product.json"), JSON.stringify({ status: "completed" }))
  await Bun.write(path.join(root, "counter.txt"), "effect\n")
  await Bun.write(path.join(root, "transport.json"), JSON.stringify({ requests: 1 }))
  const evidence = await Promise.all([
    sealEvidence(root, "product.json", "product"),
    sealEvidence(root, "counter.txt", "external"),
    sealEvidence(root, "transport.json", "transport"),
  ])
  const result: Result = {
    version: 1,
    plan: digest("plan"),
    source: "a".repeat(40),
    case: scenario.id,
    attempt: 1,
    started: 1,
    finished: 2,
    status: "passed",
    model: "passed",
    barriers: scenario.barriers,
    evidence,
    requests: [{ id: "request-1", status: "completed", usage: null }],
  }
  return result
}

test("acceptance requires product, physical and transport evidence and records unknown usage", async () => {
  await using tmp = await tmpdir()
  const result = await fixture(tmp.path)
  expect(await verifyResult(tmp.path, scenario, result, { plan: result.plan, source: result.source })).toEqual([])
  expect(result.requests[0]!.usage).toBeNull()
})

test("a duplicate side effect fails even when its changed evidence is resealed", async () => {
  await using tmp = await tmpdir()
  const result = await fixture(tmp.path)
  await Bun.write(path.join(tmp.path, "counter.txt"), "effect\neffect\n")
  result.evidence[1] = await sealEvidence(tmp.path, "counter.txt", "external")
  expect(await verifyResult(tmp.path, scenario, result, result)).toContain("oracle:counter.txt:sha256")
})

test("changing one byte or losing evidence cannot preserve a passing verdict", async () => {
  await using tmp = await tmpdir()
  const result = await fixture(tmp.path)
  await Bun.write(path.join(tmp.path, "counter.txt"), "Effect\n")
  expect(await verifyResult(tmp.path, scenario, result, result)).toContain("changed:counter.txt")
  await fs.unlink(path.join(tmp.path, "counter.txt"))
  expect(await verifyResult(tmp.path, scenario, result, result)).toContain("missing:counter.txt")
})

test("success claims without the targeted fault, real model call or complete evidence are uncovered", async () => {
  await using tmp = await tmpdir()
  const result = await fixture(tmp.path)
  result.barriers = ["effect-written"]
  result.requests = []
  result.evidence = result.evidence.filter((entry) => entry.kind !== "external")
  const errors = await verifyResult(tmp.path, scenario, result, result)
  expect(errors).toContain("untriggered:reply-lost")
  expect(errors).toContain("untriggered:recovered")
  expect(errors).toContain("missing-kind:external")
  expect(errors).toContain("uncovered:real-model")
})

test("failed, unknown, wrong-source and wrong-plan results never pass", async () => {
  await using tmp = await tmpdir()
  const result = await fixture(tmp.path)
  for (const status of ["failed", "unknown", "uncovered"] as const)
    expect(await verifyResult(tmp.path, scenario, { ...result, status }, result)).toContain(`status:${status}`)
  expect(await verifyResult(tmp.path, scenario, result, { ...result, source: "b".repeat(40) })).toContain("source")
  expect(await verifyResult(tmp.path, scenario, result, { ...result, plan: digest("other") })).toContain("plan")
})

test("evidence cannot escape the attempt directory through traversal or symlinks", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "attempt")
  await fs.mkdir(directory)
  await Bun.write(path.join(tmp.path, "outside"), "external")
  await expect(sealEvidence(directory, "../outside", "external")).rejects.toThrow()
  await fs.symlink(path.join(tmp.path, "outside"), path.join(directory, "alias"))
  await expect(sealEvidence(directory, "alias", "external")).rejects.toThrow()
})
