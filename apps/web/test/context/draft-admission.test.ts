import { expect, test } from "bun:test"
import { draftAdmission, type DraftAdmission } from "../../src/context/prompt/draft-admission"

test("an uncertain send keeps its identity through a saved draft reload, while changed or confirmed drafts get a fresh identity", () => {
  let identities = 0
  const createID = () => `message-${++identities}`
  const first = draftAdmission(undefined, "original", createID)
  const restored = JSON.parse(JSON.stringify(first)) as DraftAdmission
  expect(draftAdmission(restored, "original", createID).messageID).toBe(first.messageID)
  expect(identities).toBe(1)
  expect(draftAdmission(restored, "edited", createID).messageID).not.toBe(first.messageID)
  expect(draftAdmission(undefined, "original", createID).messageID).not.toBe(first.messageID)
})
