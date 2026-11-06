import type { SecretDetection } from "../../src/index"

export const detector: SecretDetection.Detector = {
  id: "fixture-negative",
  version: "1",
  async detect() {
    return { complete: true, findings: [] }
  },
}
