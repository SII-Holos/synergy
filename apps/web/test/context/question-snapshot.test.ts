import { expect, test } from "bun:test"
import { QuestionSnapshotGate } from "../../src/context/question-snapshot"

test("a replaced runtime cannot confirm a request snapshot", () => {
  const gate = new QuestionSnapshotGate()
  const old = gate.capture("scope-one")
  gate.reset()
  expect(gate.accept(old)).toBe(false)
  expect(gate.accept(gate.capture("scope-one"))).toBe(true)
})

test("only the newest started read can confirm pending requests", () => {
  const gate = new QuestionSnapshotGate()
  const old = gate.capture("scope-one")
  const latest = gate.capture("scope-one")
  expect(gate.accept(old)).toBe(false)
  expect(gate.accept(latest)).toBe(true)
})

test("reads in another Scope cannot invalidate a current Scope snapshot", () => {
  const gate = new QuestionSnapshotGate()
  const first = gate.capture("scope-one")
  const second = gate.capture("scope-two")
  expect(gate.accept(first)).toBe(true)
  expect(gate.accept(second)).toBe(true)
})
