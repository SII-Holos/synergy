import { describe, expect, test } from "bun:test"

const accountPanel = await Bun.file(new URL("./AccountPanel.tsx", import.meta.url)).text()
const settingsCss = await Bun.file(new URL("../settings-panel.css", import.meta.url)).text()

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

  test("keeps the profile editor as a scoped settings form", () => {
    expect(accountPanel).toContain("account-profile-form")
    expect(settingsCss).toContain(".account-profile-form")
    expect(settingsCss).toContain(".account-profile-grid")
  })
})
