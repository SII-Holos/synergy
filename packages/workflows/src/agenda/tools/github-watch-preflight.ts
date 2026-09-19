import { GitHubProvider } from "@ericsanchezok/synergy-harness/provider/github"
import { GithubWatchPolicy } from "../github-watch-policy"

/**
 * Creation-time gate for agenda items with GitHub triggers.
 *
 * A GitHub watch without a resolvable credential polls silently forever and
 * never fires — and an `agenda_watch` with `onGithub` is a continuation
 * blocker, so the origin session would wait indefinitely with no feedback.
 * Reject at creation with concrete connection steps instead of persisting an
 * item that can never fire. Token validity is deliberately not checked here
 * (that needs a live API call); an invalid token surfaces through the existing
 * consecutive-failure auto-pause in the poll loop.
 */
export namespace GithubWatchPreflight {
  export interface Rejection {
    title: string
    output: string
    metadata: Record<string, any>
  }

  export async function check(toolName: string): Promise<Rejection | undefined> {
    const watch = await GithubWatchPolicy.read()
    if (watch?.enabled === false) {
      return {
        title: `${toolName} rejected`,
        output: [
          `GitHub triggers are disabled (github.watch.enabled=false in config).`,
          ``,
          `Ask the user to enable them in Settings → GitHub → "Allow GitHub agenda triggers", or set github.watch.enabled=true in 115-github.jsonc.`,
        ].join("\n"),
        metadata: { blocked: true, reason: "github_watch_disabled" } as Record<string, any>,
      }
    }
    const resolved = await GitHubProvider.resolveToken()
    if (!resolved?.token) {
      return {
        title: `${toolName} rejected`,
        output: [
          `No connected GitHub credential — this GitHub watch would poll silently forever and never fire.`,
          ``,
          `Connect one first, then retry this exact call:`,
          `1. Ask the user to connect GitHub in Settings → GitHub (device login, import gh auth token, or paste a token).`,
          `2. Or ensure GH_TOKEN / GITHUB_TOKEN is exported in the Synergy server environment.`,
          ``,
          `Do not substitute a timed delay loop that shell-checks GitHub — that is the approximation this connection replaces. If the user declines to connect, tell them GitHub watches need a credential.`,
        ].join("\n"),
        metadata: { blocked: true, reason: "github_credential_missing" } as Record<string, any>,
      }
    }
    return undefined
  }
}
