import { RegexDetector, SecretDetection } from "@ericsanchezok/synergy-secret-detection"

export namespace SecretDetectorSource {
  let detector: SecretDetection.Detector = RegexDetector

  export function register(value: SecretDetection.Detector | undefined): void {
    detector = value ?? RegexDetector
  }

  export function get(): SecretDetection.Detector {
    return detector
  }
}
