/**
 * Scans command output for OS-level sandbox denial patterns.
 */
export namespace SandboxDetector {
  const DENIAL_PATTERNS: { pattern: RegExp; label: string }[] = [
    { pattern: /[Oo]peration not permitted/, label: "operation_not_permitted" },
    { pattern: /[Pp]ermission denied/, label: "permission_denied" },
    { pattern: /[Rr]ead-only file system/, label: "read_only_filesystem" },
    { pattern: /[Nn]ot a directory/, label: "not_a_directory" },
    { pattern: /[Cc]ouldn'?t\s?(read|access|open)/i, label: "couldnt_read" },
    { pattern: /[Ss]andbox/i, label: "sandbox" },
    { pattern: /error loading current directory/i, label: "cwd_broken" },
    { pattern: /\bEACCES\b|\bEPERM\b/, label: "unix_perm" },
  ]

  export interface Match {
    label: string
    matched: string
    line: string
  }

  /**
   * Scan combined stdout+stderr for sandbox denial patterns.
   * Returns all matched patterns or empty array.
   */
  export function scan(output: string): Match[] {
    const matches: Match[] = []
    for (const line of output.split("\n")) {
      for (const { pattern, label } of DENIAL_PATTERNS) {
        const m = pattern.exec(line)
        if (m) {
          matches.push({ label, matched: m[0], line: line.trim() })
          break
        }
      }
    }
    return matches
  }

  /**
   * Build a human-readable explanation from matched patterns.
   * This message is returned to the model so it understands the situation.
   */
  export function explain(matches: Match[]): string {
    if (matches.length === 0) return ""

    const labels = [...new Set(matches.map((m) => m.label))]
    const evidence = matches
      .slice(0, 3)
      .map((m) => `  ${m.matched}`)
      .join("\n")

    const category =
      labels.includes("not_a_directory") || labels.includes("cwd_broken")
        ? "The shell process lost access to its working directory. This is a system-level filesystem boundary — the directory is outside the sandbox or excluded by OS permissions. Do NOT retry the same path."
        : labels.includes("read_only_filesystem")
          ? "The file system is mounted read-only or is protected by the sandbox from writes."
          : "The sandbox blocked this operation. This is a filesystem boundary enforced by the permission profile."

    return [
      `## Sandbox Denial Detected`,
      ``,
      category,
      ``,
      `Matched patterns:`,
      evidence,
      ``,
      `To proceed, you must either:`,
      `1. Use a workspace-relative path, or`,
      `2. Request the user to approve the operation with escalated permissions.`,
      `If this is a system directory outside your workspace, do NOT retry — report the limitation.`,
    ].join("\n")
  }
}
