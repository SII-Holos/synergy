import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("fork confirm dialog markup", () => {
  const source = readFileSync(join(import.meta.dir, "../../../src/components/session/dialog-fork-confirm.tsx"), "utf8")

  test("renders a compact dialog with an impact card and cancel/confirm actions", () => {
    expect(source).toContain('size="compact"')
    expect(source).toContain('class="fork-confirm-dialog"')
    expect(source).toContain('class="fork-confirm-impact"')
    expect(source).toContain('data-slot="dialog-actions"')
  })

  test("disables actions and shows a spinner while the fork is pending", () => {
    expect(source).toMatch(/disabled=\{state\.pending\}/)
    expect(source).toContain('class="fork-confirm-spinner"')
    expect(source).toContain("forkConfirmForking")
  })

  test("closes the dialog only after a successful fork", () => {
    expect(source).toContain("const ok = await props.onConfirm()")
    expect(source).toContain("if (ok) dialog.close()")
  })

  test("uses statically extractable Lingui descriptors for dialog copy", () => {
    expect(source).toContain("forkConfirmTitle")
    expect(source).toContain("forkConfirmDescriptionPreview")
    expect(source).toContain("forkConfirmThisCopies")
    expect(source).toContain("forkConfirmCopiedNote")
  })
})
