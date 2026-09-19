import type { SecretDetection } from "./detector.js"
import { SecretPatterns } from "./patterns.js"

export const RegexDetector: SecretDetection.Detector = {
  id: "standalone-regex",
  version: "1",
  async detect({ text, signal }) {
    signal?.throwIfAborted()
    const found: SecretDetection.Finding[] = []
    for (const pattern of SecretPatterns.standalone) {
      for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
        found.push({ start: match.index, end: match.index + match[0].length, kind: "token" })
      }
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end)
    const findings: SecretDetection.Finding[] = []
    for (const finding of found) {
      const previous = findings.at(-1)
      if (previous && finding.start < previous.end) previous.end = Math.max(previous.end, finding.end)
      else findings.push(finding)
    }
    return { findings, complete: true }
  },
}
