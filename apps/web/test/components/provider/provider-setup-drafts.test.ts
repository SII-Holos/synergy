import { expect, test } from "bun:test"
import {
  createProviderSetupDrafts,
  nextProviderAccountName,
} from "../../../src/components/provider/provider-setup-drafts"

test("account remarks avoid occupied generated names", () => {
  expect(nextProviderAccountName(["Account 2", "Work", "Account 3"], (n) => `Account ${n}`)).toBe("Account 4")
})

test("setup inputs and creation identity survive view changes and clear on dismissal", () => {
  const drafts = createProviderSetupDrafts()
  const id = drafts.get("additional:codex").id
  drafts.update("additional:codex", { name: "Work", apiKey: "fixture-key", targetID: "account-created" })
  expect(drafts.get("additional:codex")).toMatchObject({
    id,
    name: "Work",
    apiKey: "fixture-key",
    targetID: "account-created",
  })
  expect(drafts.get("existing:codex").apiKey).toBe("")
  drafts.clear()
  expect(drafts.get("additional:codex").apiKey).toBe("")
  expect(drafts.get("additional:codex").id).not.toBe(id)
})
