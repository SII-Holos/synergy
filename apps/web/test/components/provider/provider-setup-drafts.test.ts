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

test("dismissal tracks metadata separately from saved receipts and unsaved credentials", () => {
  const drafts = createProviderSetupDrafts()
  drafts.get("setup:service", { name: "Configured", endpoint: "https://example.com/v1" })
  expect(drafts.dirty()).toBe(false)
  drafts.update("setup:service", { name: "Work" })
  expect(drafts.dirty()).toBe(true)
  drafts.update("setup:service", { targetID: "created-account" })
  expect(drafts.dirty()).toBe(false)
  drafts.update("setup:service", { apiKey: "fixture-key" })
  expect(drafts.dirty()).toBe(true)
  drafts.update("setup:service", { credentialsSaved: true, apiKey: "" })
  expect(drafts.dirty()).toBe(false)
  drafts.get("existing:service")
  drafts.update("existing:service", { credentialsStarted: true })
  expect(drafts.dirty()).toBe(true)
  drafts.clear()
  expect(drafts.dirty()).toBe(false)
})

test("an account write remains pending across consumers until its receipt settles", () => {
  const drafts = createProviderSetupDrafts()
  const fields = { name: "Personal", endpoint: "", enabled: true }
  const draft = drafts.get("edit:service", fields)
  drafts.update("edit:service", { name: "Work", pending: true })
  expect(drafts.get("edit:service", fields)).toBe(draft)
  expect(drafts.pending()).toBe(true)
  expect(drafts.dirty("edit:service")).toBe(true)
  drafts.update("edit:service", { pending: false })
  expect(drafts.pending()).toBe(false)
})

test("custom model-only changes remain dirty across settings sections", () => {
  const drafts = createProviderSetupDrafts()
  drafts.get("custom:new")
  drafts.update("custom:new", {
    custom: {
      providerID: "",
      protocol: "openai-completions",
      models: [
        {
          key: "one",
          id: "model-a",
          name: "",
          context: "",
          output: "",
          toolCall: true,
          image: false,
          reasoning: false,
          expanded: false,
        },
      ],
    },
    customBaseline: "",
  })
  expect(drafts.dirty()).toBe(true)
  drafts.setView("customOpen", true)
  expect(drafts.view.customOpen).toBe(true)
  drafts.clear()
  expect(drafts.dirty()).toBe(false)
  expect(drafts.view.customOpen).toBe(false)
})
