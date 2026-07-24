import { describe, expect, test } from "bun:test"
import type { ResourceOpenController } from "../../src/context/resource-open"

const legacyController: ResourceOpenController = {
  open() {
    return false
  },
  openAttachment() {
    return false
  },
}

describe("resource open controller compatibility", () => {
  test("keeps workspace source capabilities optional for existing providers", () => {
    expect(legacyController.open({ kind: "url", url: "https://example.com" })).toBe(false)
  })
})
