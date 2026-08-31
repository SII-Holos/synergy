import z from "zod"
import { Channel } from "@/channel"
import { GithubProvider } from "@/channel/provider/github"
import { Tool } from "../../tool/tool"

const Parameters = z.object({
  branch: z
    .string()
    .min(1)
    .max(200)
    .describe("Local branch name containing the committed fix (e.g. synergy/fix/issue-123-slug)."),
  title: z.string().min(1).max(256).describe("Concise pull request title."),
  body: z.string().max(8000).describe("Pull request body: what was wrong, what changed, and the test results."),
})

function toolError(code: string, message: string, metadata?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code }, metadata)
}

/**
 * Deliver a locally committed fix as a pull request. The agent commits on a
 * local branch inside the thread checkout and calls this tool; the provider
 * pushes the branch with an ephemeral installation token (never exposed to
 * the agent) and opens a deduplicated PR against the repository default
 * branch.
 */
export const GithubDeliverFixTool = Tool.define(
  "github_deliver_fix",
  {
    description:
      "Deliver a locally committed fix as a GitHub pull request. The current session supplies the repository thread; provide the local branch name, a concise title, and a body describing what was wrong, what changed, and the test results. The provider pushes the branch and opens (or reuses) the PR.",
    parameters: Parameters,
    async execute(params, ctx) {
      const provider = Channel.getProvider("github")
      if (!(provider instanceof GithubProvider)) {
        throw toolError("GITHUB_PROVIDER_UNAVAILABLE", "The GitHub Channel provider is unavailable")
      }
      try {
        const result = await provider.deliverFix(
          {
            sessionID: ctx.sessionID,
            branch: params.branch,
            title: params.title,
            body: params.body,
          },
          ctx.abort,
        )
        return {
          title: "GitHub fix delivered as pull request",
          output: `Pull request #${result.pullNumber} is ready: ${result.pullRequestURL}`,
          metadata: {
            pullRequestURL: result.pullRequestURL,
            pullNumber: result.pullNumber,
            headBranch: result.headBranch,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("not bound to a GitHub channel thread")) {
          throw toolError("GITHUB_TOOL_NOT_IN_CHANNEL_SESSION", message)
        }
        if (message.startsWith("Invalid branch name")) {
          throw toolError("GITHUB_DELIVERY_INVALID_BRANCH", message)
        }
        if (message.includes("does not exist")) {
          throw toolError("GITHUB_DELIVERY_BRANCH_MISSING", message)
        }
        if (message.includes("is the repository base branch")) {
          throw toolError("GITHUB_DELIVERY_BASE_BRANCH", message)
        }
        if (message.includes("no commits ahead")) {
          throw toolError("GITHUB_DELIVERY_BRANCH_EMPTY", message)
        }
        if (message.startsWith("Failed to push branch")) {
          throw toolError("GITHUB_DELIVERY_PUSH_FAILED", message)
        }
        throw error
      }
    },
  },
  {
    // The GitHub channel agent runs under a strict whitelist permission and
    // has no expand_tools/search_tools activation path, so a search-mode
    // exposure would leave the tool permanently invisible. Expose it as
    // resident; the tool itself validates that the session is bound to a
    // GitHub channel thread and errors otherwise.
    exposure: {
      mode: "resident",
    },
  },
)
