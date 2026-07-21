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

    expect(shown!.title).toBe("Delete node")
    expect(shown!.description).toBe("This removes the research node from the map.")
    expect(shown!.confirmLabel).toBe("Delete")
    expect(shown!.cancelLabel).toEqual({ id: "app.common.cancel", message: "Cancel" })
    expect(shown!.tone).toBe("neutral")

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

    expect(shown!.confirmLabel).toEqual({ id: "app.common.confirm", message: "Confirm" })
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
