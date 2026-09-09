import { describe, expect, test, mock } from "bun:test"

const labels = {
  successTitle: "Session ID copied",
  failureLabel: "Copy session ID",
  failureDescription: "Failed to copy session ID",
}

// Mock before any import of session-copy so the real clipboard chain (which
// pulls in solid-js client components) is never loaded in the test runner.
mock.module("@ericsanchezok/synergy-ui/clipboard", () => ({
  copyTextToClipboard: mock(async () => ({ ok: true, method: "navigator" })),
}))

mock.module("@ericsanchezok/synergy-ui/toast", () => ({
  showToast: mock(() => 1),
}))

describe("copySessionID", () => {
  test("copies the raw session id and shows a success toast on success", async () => {
    const { copySessionID } = await import("../../src/utils/session-copy")
    const { copyTextToClipboard } = await import("@ericsanchezok/synergy-ui/clipboard")
    const { showToast } = await import("@ericsanchezok/synergy-ui/toast")
    const copyMock = copyTextToClipboard as ReturnType<typeof mock>
    const toastMock = showToast as ReturnType<typeof mock>
    copyMock.mockClear()
    toastMock.mockClear()
    copyMock.mockResolvedValueOnce({ ok: true, method: "desktop" })

    await copySessionID("ses_123", labels)

    expect(copyMock).toHaveBeenCalledWith("ses_123", {
      label: labels.failureLabel,
      failureDescription: labels.failureDescription,
    })
    expect(toastMock).toHaveBeenCalledWith({ type: "success", title: labels.successTitle })
  })

  test("does not show a success toast when copying fails", async () => {
    const { copySessionID } = await import("../../src/utils/session-copy")
    const { copyTextToClipboard } = await import("@ericsanchezok/synergy-ui/clipboard")
    const { showToast } = await import("@ericsanchezok/synergy-ui/toast")
    const copyMock = copyTextToClipboard as ReturnType<typeof mock>
    const toastMock = showToast as ReturnType<typeof mock>
    copyMock.mockClear()
    toastMock.mockClear()
    copyMock.mockResolvedValueOnce({ ok: false, reason: "unavailable" })

    await copySessionID("ses_123", labels)

    expect(copyMock).toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
  })
})
