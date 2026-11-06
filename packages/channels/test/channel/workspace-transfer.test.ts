import { expect, test } from "bun:test"
import { ChannelWorkspaceTransfer } from "../../src/channel/workspace-transfer"

test("Channel transfer relocates only owned records and preserves unknown provider data", () => {
  const retained = {
    directory: "/old/repository",
    workspaceID: "work-old",
    scopeID: "scope-owner",
    providerData: { directory: "/old/repository" },
  }
  const resolve = () => "work-new"
  const relocate = (directory: string) => directory.replace("/old/", "/new/")
  expect(ChannelWorkspaceTransfer.record(["other", "managed_ownership", "item"], retained, resolve, relocate)).toBe(
    retained,
  )
  expect(ChannelWorkspaceTransfer.record(["channel", "unknown", "item"], retained, resolve, relocate)).toBe(retained)
  expect(
    ChannelWorkspaceTransfer.record(["channel", "managed_ownership", "item"], retained, resolve, relocate),
  ).toEqual({ ...retained, directory: "/new/repository" })
  expect(
    ChannelWorkspaceTransfer.record(
      ["channel", "providers", "github", "accounts", "account", "workspaces", "index", "item"],
      retained,
      resolve,
      relocate,
    ),
  ).toEqual({ ...retained, directory: "/new/repository", workspaceID: "work-new" })
})
