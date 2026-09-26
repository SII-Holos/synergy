import { RuntimeContext } from "../lifecycle/context"
import { RegexDetector, SecretDetection } from "@ericsanchezok/synergy-secret-detection"

export namespace SecretDetectorSource {
  const runtimeState = RuntimeContext.state(() => ({
    detector: RegexDetector as SecretDetection.Detector,
  }))

  export function register(value: SecretDetection.Detector | undefined): void {
    const instanceState = runtimeState()

    instanceState.detector = value ?? RegexDetector
  }

  export function get(): SecretDetection.Detector {
    const instanceState = runtimeState()

    return instanceState.detector
  }
}
