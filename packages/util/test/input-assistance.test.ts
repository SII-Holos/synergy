import { expect, test } from "bun:test"
import { InputAssistance } from "../src/input-assistance"

test("assistance records only fingerprints and keeps producer identity across edits", () => {
  const accepted = InputAssistance.accept(undefined, {
    producer: "completion",
    proposalID: "proposal",
    generated: "继续",
    accepted: "继续",
  })
  const submitted = InputAssistance.submit(accepted, "继续，把测试跑了")
  expect(submitted?.proposals[0]?.generatedFingerprint).toBe(submitted?.proposals[0]?.acceptedFingerprint)
  expect(submitted?.submittedFingerprint).not.toBe(submitted?.proposals[0]?.acceptedFingerprint)
  expect(InputAssistance.read({ assistance: submitted })).toEqual(submitted)
  expect(InputAssistance.read({})).toBeUndefined()
  expect(InputAssistance.submit(undefined, "独立输入")).toBeUndefined()
  expect(JSON.stringify(submitted)).not.toContain("继续")
})
