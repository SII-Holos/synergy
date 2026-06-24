import {
  type SandboxBlockExplanation,
  type SandboxBlockKind,
  type FileAccess,
  type PlatformName,
  type SandboxNetworkMode,
  type DenialSource,
  buildExplanation,
  formatExplanation,
} from "@/sandbox/explain"
import type { SandboxMode } from "@/sandbox/types"
/**
 * Scans command output for OS-level sandbox denial patterns.
 * Detects platform-specific sandbox blocks (macOS Seatbelt, Linux seccomp/bwrap, Windows)
 * and returns structured results with platform, access type, path, and confidence.
 */

export interface SandboxDetectionResult {
  matched: boolean
  platform?: "macos" | "linux" | "windows"
  access?: "read" | "write" | "network" | "execute"
  path?: string
  networkTarget?: string
  raw: string
  confidence: "high" | "medium" | "low"
  label: string
}

interface DetectionPattern {
  pattern: RegExp
  label: string
  platform: "macos" | "linux" | "windows" | "any"
  access: "read" | "write" | "network" | "execute"
  confidence: "high" | "medium" | "low"
  /** Regex capture group index for path extraction */
  pathGroup?: number
  /** Regex capture group index for network target */
  networkGroup?: number
}

const PATTERNS: DetectionPattern[] = [
  // macOS Seatbelt sandbox-exec denial
  {
    pattern: /deny\(file-read\*?\).*?\(path.*?"([^"]+)/s,
    label: "seatbelt_file_read",
    platform: "macos",
    access: "read",
    confidence: "high",
    pathGroup: 1,
  },
  {
    pattern: /deny\(file-write\*?\).*?\(path.*?"([^"]+)/s,
    label: "seatbelt_file_write",
    platform: "macos",
    access: "write",
    confidence: "high",
    pathGroup: 1,
  },
  {
    pattern: /deny\(network-outbound\)/,
    label: "seatbelt_network",
    platform: "macos",
    access: "network",
    confidence: "high",
  },
  {
    pattern: /Operation not permitted/i,
    label: "macos_eperm",
    platform: "macos",
    access: "read",
    confidence: "low",
  },

  // Linux seccomp / bwrap denials
  {
    pattern: /bad system call|invalid argument/i,
    label: "seccomp_syscall",
    platform: "linux",
    access: "execute",
    confidence: "medium",
  },
  {
    pattern: /Operation not permitted.*seccomp|seccomp.*Operation not permitted/i,
    label: "seccomp_eperm",
    platform: "linux",
    access: "execute",
    confidence: "high",
  },
  {
    pattern: /EACCES|EPERM/,
    label: "unix_perm",
    platform: "linux",
    access: "read",
    confidence: "low",
  },
  {
    pattern: /Mount.*denied|bwrap: Can't bind mount.*"([^"]+)/i,
    label: "bwrap_mount",
    platform: "linux",
    access: "write",
    confidence: "high",
    pathGroup: 1,
  },

  // Windows denials
  {
    pattern: /Access is denied\.\s*\\([^\n\\]+)/i,
    label: "win_access_denied",
    platform: "windows",
    access: "read",
    confidence: "high",
    pathGroup: 1,
  },
  {
    pattern: /Access is denied/i,
    label: "win_access_denied_pure",
    platform: "windows",
    access: "read",
    confidence: "medium",
  },
  {
    pattern: /ERROR_ACCESS_DENIED/i,
    label: "win_err_access_denied",
    platform: "windows",
    access: "read",
    confidence: "high",
  },
  {
    pattern: /A required privilege is not held/i,
    label: "win_privilege",
    platform: "windows",
    access: "execute",
    confidence: "high",
  },
  {
    pattern: /The system cannot find the path specified/i,
    label: "win_path_not_found",
    platform: "windows",
    access: "read",
    confidence: "low",
  },
]

export namespace SandboxDetector {
  export function scan(output: string): SandboxDetectionResult[] {
    const results: SandboxDetectionResult[] = []

    for (const pat of PATTERNS) {
      const match = pat.pattern.exec(output)
      if (match) {
        results.push({
          matched: true,
          platform: pat.platform === "any" ? undefined : pat.platform,
          access: pat.access,
          path: pat.pathGroup !== undefined ? (match[pat.pathGroup] ?? undefined) : undefined,
          networkTarget: pat.networkGroup !== undefined ? (match[pat.networkGroup] ?? undefined) : undefined,
          raw: match[0],
          confidence: pat.confidence,
          label: pat.label,
        })
      }
    }

    return results
  }

  /**
   * Find the best (highest confidence) detection result.
   */
  export function bestMatch(output: string): SandboxDetectionResult | null {
    const results = scan(output)
    if (results.length === 0) return null

    // Prefer "high" confidence matches
    const high = results.filter((r) => r.confidence === "high")
    if (high.length > 0) return high[0]

    const medium = results.filter((r) => r.confidence === "medium")
    if (medium.length > 0) return medium[0]

    return results[0]
  }

  /**
   * Check if any sandbox denial was detected.
   */
  export function detected(output: string): boolean {
    return scan(output).length > 0
  }

  /**
   * Build a human-readable explanation from detection results.
   */
  export function explain(results: SandboxDetectionResult[]): string {
    if (results.length === 0) return ""

    const evidence = results
      .slice(0, 3)
      .map((r) => `  ${r.raw}`)
      .join("\n")

    const highMatch = results.find((r) => r.confidence === "high")
    const category = highMatch
      ? `The ${highMatch.platform ?? "OS"} sandbox blocked this operation (${highMatch.access}). This is a filesystem boundary enforced by the permission profile.`
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

  /**
   * Build a structured SandboxBlockExplanation from detection results.
   * Combines OS-level detection patterns with profile metadata to produce
   * a complete explanation with recovery actions.
   */
  export function buildBlockExplanation(
    detections: SandboxDetectionResult[],
    profile?: {
      command?: string
      profileMode?: SandboxMode
      networkMode?: SandboxNetworkMode
      allowedReadRoots?: string[]
      allowedWriteRoots?: string[]
      backend?: string | null
    },
  ): SandboxBlockExplanation | null {
    if (detections.length === 0) return null

    // Use the highest-confidence match (scan returns best first)
    const best = detections[0]!
    const platform: PlatformName = best.platform ?? "linux"

    // Map SandboxDetectionResult access → SandboxBlockKind
    const kindMap: Record<string, SandboxBlockKind> = {
      read: "filesystem",
      write: "filesystem",
      network: "network",
      execute: "process",
    }
    const kind: SandboxBlockKind = best.access ? (kindMap[best.access] ?? "unknown") : "unknown"

    // Map SandboxDetectionResult access → FileAccess for the explanation
    const fileAccessMap: Record<string, FileAccess> = {
      read: "read",
      write: "write",
      execute: "execute",
      network: "read",
    }
    const access: FileAccess | undefined = best.access ? (fileAccessMap[best.access] ?? undefined) : undefined

    // Collect denied paths
    const deniedPaths: string[] = []
    for (const d of detections) {
      if (d.path && !deniedPaths.includes(d.path)) {
        deniedPaths.push(d.path)
      }
    }

    return buildExplanation({
      kind,
      platform,
      backend: profile?.backend ?? null,
      command: profile?.command ?? "unknown",
      access,
      path: best.path,
      networkTarget: best.networkTarget,
      denialSource: "os",
      rawMessage: best.raw,
      profileMode: profile?.profileMode,
      networkMode: profile?.networkMode,
      allowedReadRoots: profile?.allowedReadRoots,
      allowedWriteRoots: profile?.allowedWriteRoots,
      deniedPaths,
    })
  }

  /**
   * Build a block explanation from detections and format it as a string.
   * Falls back to legacy explain() output when no structured profile info is available.
   */
  export function formatBlockExplanation(
    detections: SandboxDetectionResult[],
    profile?: Parameters<typeof buildBlockExplanation>[1],
  ): string {
    const explanation = buildBlockExplanation(detections, profile)
    if (explanation) return formatExplanation(explanation)
    return explain(detections)
  }
}
