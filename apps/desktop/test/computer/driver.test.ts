import { expect, test } from "bun:test"
import { ComputerDriver } from "../../src/computer/driver"

test.skipIf(process.platform !== "darwin")(
  "a missing driver fails promptly and can be closed",
  async () => {
    const driver = new ComputerDriver("/nonexistent/synergy-computer-test-driver", () => {})
    try {
      await expect(driver.execute("task", { type: "apps" })).rejects.toThrow("Cannot start")
    } finally {
      await driver.close()
    }
  },
  3000,
)

test.skipIf(process.platform !== "darwin")("OS permission failure prevents native startup", async () => {
  const driver = new ComputerDriver("/nonexistent/synergy-computer-test-driver", () => {
    throw new Error("Accessibility required")
  })
  try {
    await expect(driver.execute("task", { type: "apps" })).rejects.toThrow("Accessibility required")
  } finally {
    await driver.close()
  }
})
