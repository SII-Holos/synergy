import { describe, expect, test } from "bun:test"

const accountPanel = await Bun.file(
  new URL("../../../../src/components/settings/panels/AccountPanel.tsx", import.meta.url),
).text()
const settingsCss = await Bun.file(
  new URL("../../../../src/components/settings/settings-panel.css", import.meta.url),
).text()

describe("Account settings profile panel", () => {
  test("edits the remote Holos profile through the SDK", () => {
    expect(accountPanel).toContain("globalSDK.client.holos.profile.update")
    expect(accountPanel).toContain("profileForm.name")
    expect(accountPanel).toContain("profileForm.description")
    expect(accountPanel).toContain("profileForm.avatarUrl")
    expect(accountPanel).toContain("holos.state.social.profileError")
  })

  test("does not read old local profile or account label fields", () => {
    expect(accountPanel).not.toContain(".bio")
    expect(accountPanel).not.toContain("initialized")
    expect(accountPanel).not.toContain("account.label")
  })

  test("keeps profile editing behind an explicit edit state", () => {
    expect(accountPanel).toContain("editingProfile")
    expect(accountPanel).toContain("Edit profile")
    expect(accountPanel).toContain("Save changes")
    expect(accountPanel).toContain("account-profile-form")
    expect(accountPanel).toContain("account-profile-display")
    expect(settingsCss).toContain(".account-profile-form")
    expect(settingsCss).toContain(".account-profile-card")
  })

  test("moves saved-agent switching out of the main Account page", () => {
    expect(accountPanel).toContain("actions.openAgentSwitcher")
    expect(accountPanel).not.toContain("account-agent-row")
    expect(accountPanel).not.toContain("<For each={holos.state.identity.accounts}>")
  })

  test("keeps logout with the current identity card and hides raw profile errors", () => {
    expect(accountPanel).toContain("account-profile-card-actions")
    expect(accountPanel).toContain("account-profile-logout")
    expect(accountPanel).toContain("Holos could not load this profile")
    expect(accountPanel).not.toContain("<span>{holos.state.social.profileError}</span>")
  })
})
