import { describe, expect, test } from "bun:test"
import type { ConfirmOptions } from "@/components/dialog/confirm-dialog"
import { requestPluginHostConfirm } from "./host-confirm"

describe("requestPluginHostConfirm", () => {
  test("resolves true after the shared confirm dialog confirms", async () => {
    let shown: ConfirmOptions | undefined
    const result = requestPluginHostConfirm(
      (options) => {
        shown = options
      },
      {
        title: "Delete node",
        message: "This removes the research node from the map.",
        confirmLabel: "Delete",
      },
    )

    expect(shown).toMatchObject({
      title: "Delete node",
      description: "This removes the research node from the map.",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      tone: "neutral",
    })

    await shown?.onConfirm()
    shown?.onConfirmed?.()
    await expect(result).resolves.toBe(true)
  })

  test("defaults the confirm label and resolves false on dismiss", async () => {
    let shown: ConfirmOptions | undefined
    const result = requestPluginHostConfirm(
      (options) => {
        shown = options
      },
      {
        title: "Continue",
        message: "Proceed with the linked Session?",
      },
    )

    expect(shown?.confirmLabel).toBe("Confirm")
    shown?.onDismiss?.()
    await expect(result).resolves.toBe(false)
  })

  test("settles only once when confirm and dismiss both fire", async () => {
    let shown: ConfirmOptions | undefined
    const result = requestPluginHostConfirm(
      (options) => {
        shown = options
      },
      {
        title: "Retry",
        message: "Retry the failed stage?",
      },
    )

    await shown?.onConfirm()
    shown?.onDismiss?.()
    await expect(result).resolves.toBe(true)
  })
})
