import { expect, test } from "bun:test"
import { AttachmentDelivery } from "../../src/attachment/delivery"
import { testRuntime } from "../support/runtime"

test("delivery instructions are copied at composition and isolated from another runtime", async () => {
  const supplied = { response: "Use the host receipt.", execution: "Save through the host delivery tool." }
  await using custom = await testRuntime({ register: () => AttachmentDelivery.register(supplied) })
  await using normal = await testRuntime()
  supplied.response = "Changed after opening"
  await Promise.all([
    custom.run(async () => {
      await Promise.resolve()
      expect(AttachmentDelivery.guidance()).toEqual({
        response: "Use the host receipt.",
        execution: "Save through the host delivery tool.",
      })
      expect(() => AttachmentDelivery.register(supplied)).toThrow("before opening")
    }),
    normal.run(async () => {
      await Promise.resolve()
      expect(AttachmentDelivery.guidance().response).toContain("[descriptive filename](asset://...)")
      expect(AttachmentDelivery.guidance().execution).toContain("captured as immutable attachments")
    }),
  ])
})

test("composition rejects incomplete or conflicting delivery registrations", async () => {
  await expect(
    testRuntime({ register: () => AttachmentDelivery.register({ response: "Valid", execution: " " }) }),
  ).rejects.toThrow("response and execution")
  await expect(
    testRuntime({
      register() {
        AttachmentDelivery.register({ response: "First", execution: "First" })
        AttachmentDelivery.register({ response: "Second", execution: "Second" })
      },
    }),
  ).rejects.toThrow("already registered")
})
