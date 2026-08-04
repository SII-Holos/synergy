# GitHub Channel

The GitHub channel turns a GitHub account (a GitHub App installation) into a Synergy Channel, like Feishu or Clarus. It polls the GitHub REST API outbound using GitHub App installation tokens, synthesizes repository events into conversation messages, and runs an agentic loop that reviews pull requests, answers questions, and fixes issues — posting results back as GitHub comments.

The channel reuses the standard Channel runtime: providers register through `Channel.registerProvider()`, inbound events flow through `ChannelHost.conversations.receive()`, sessions are persisted per issue/PR thread under the Channel navigation section, and replies are delivered by `ChannelOutbound` through the provider's `replyMessage`/`pushMessage`.

## Why a channel (migration from the legacy integration)

The former first-party GitHub integration (`packages/synergy/src/github/`) used a bespoke delivery store, gate, worker, and Cortex-anchored subagents. It was migrated into a channel provider so GitHub reuses the same lifecycle, session persistence, sidebar projection, diagnostics, and settings UI as Feishu/Clarus:

- **Lifecycle** — the provider connects when the account is enabled; polling loops start and stop with the account; status surfaces in Settings → Channels.
- **Sessions** — every issue/PR thread maps to one persistent channel Session (endpoint `channel:github:<accountId>:chat:<owner/repo>#<number>`), so the sidebar shows the whole conversation history and follow-up comments continue the same thread.
- **Scope isolation** — each thread owns a dedicated checkout directory under the configured `workspaceDir`, bound to its own project Scope, so the agent reviews the exact PR head or issue branch without touching user projects.
- **Agentic loop retained** — unlike PR-Agent's single-shot tools, each GitHub event is a full agentic Session (the `github-channel-agent`) with read/edit/bash tool access inside the checkout, autonomous control profile, and its final message posted as the GitHub comment.

## Configuration

```jsonc
// 90-channels.jsonc
{
  "channel": {
    "github": {
      "type": "github",
      "accounts": {
        "default": {
          "enabled": true,
          "repositories": ["owner/repo"],
          "workspaceDir": "github-workspaces",
          "pollingIntervalMs": 300000,
          "autoReview": true,
          "autoRespond": true,
          "agent": "github-channel-agent",
        },
      },
    },
  },
}
```

| Field               | Default                | Description                                                                                                                                  |
| ------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`           | `true`                 | Master switch for the account.                                                                                                               |
| `repositories`      | required               | `owner/repo` list to watch and respond to.                                                                                                   |
| `workspaceDir`      | required               | Directory (relative to the Synergy data home) under which per-thread checkouts are created.                                                  |
| `pollingIntervalMs` | `300000`               | Poll interval (5 minutes by default; the legacy integration polled every 60s — a lower frequency is intentional to stay within rate limits). |
| `autoReview`        | `true`                 | Automatically review newly opened and updated pull requests.                                                                                 |
| `autoRespond`       | `true`                 | Respond to `@synergy` mentions and answer issue/PR questions.                                                                                |
| `agent`             | `github-channel-agent` | Agent used for GitHub channel sessions.                                                                                                      |
| `model` / `variant` | —                      | Per-account model override (same shape as Feishu accounts).                                                                                  |

GitHub App credentials stay in the environment: `SYNERGY_GITHUB_APP_ID` and `SYNERGY_GITHUB_APP_PRIVATE_KEY`. The provider signs a JWT, resolves the repository installation, and uses short-lived installation tokens for both the REST API and git operations (via a credential helper that never exposes the token to agents).

## Polling

One loop runs per configured repository while the account is connected. Each cycle:

1. Resolves the installation token for the repository.
2. Lists issues updated since the watermark (`GET /repos/{o}/{r}/issues?since=...&sort=updated&direction=asc`).
3. Fetches pull request details for PR-shaped entries (`GET /repos/{o}/{r}/pulls/{n}`).
4. Lists comments on every issue/PR in the window (`GET /repos/{o}/{r}/issues/{n}/comments?since=...`) — this is the `@synergy` summon surface.
5. Synthesizes events (`issue.opened`, `pull_request.opened`, `pull_request.synchronize`, `pull_request.ready_for_review`, `comment.created`) with a deterministic dedup state, and delivers each through `ChannelHost.conversations.receive()`.

Rate-limit errors (403/429) extend the sleep using `Retry-After`/`x-ratelimit-reset`. Poll state (`seenIssues`, `seenPullRequests`, `seenComments`, watermarks) is persisted per account + repository under `data/channel/providers/github/accounts/<hash>/poll-state/...` and pruned to bound growth (open PRs + 5k recent closed; 10k comment IDs).

## Event gating

`gateGithubEvent()` decides which synthesized events reach the conversation pipeline:

- `comment.created` — delivered **only when the comment mentions `@synergy`** (case-insensitive, word boundary) and `autoRespond` is on. This is the summon rule: ordinary chatter never wakes an agent.
- `issue.opened` — delivered when `autoRespond` is on.
- `pull_request.opened` / `pull_request.synchronize` / `pull_request.ready_for_review` — delivered when `autoReview` is on.

Skipped events are logged and never create sessions.

### Draft pull requests

Draft PRs are excluded from automatic review:

- Opening a draft PR records it in poll state (with its `draft: true` flag) but produces **no** `pull_request.opened` event.
- Pushing to a draft PR updates the recorded head SHA but produces **no** `pull_request.synchronize` event.
- When a draft PR is marked ready for review (`draft: true` → `draft: false`), the synthesizer emits a `pull_request.ready_for_review` event, which triggers the same auto-review path as a fresh PR.

This mirrors the industry pattern (PR-Agent/Codex/CodeRabbit): drafts are silent until the author asks for review.

## Checkout management (per-thread Scope)

Each issue/PR thread resolves to a deterministic random-hash directory under `workspaceDir`:

```text
<workspaceDir>/<sha256("owner/repo#<number>").slice(0,16)>/
```

`GithubChannelWorkspace.ensure()`:

- Creates the directory if missing, then clones the repository with the installation token (credential helper; token never on argv).
- For PR threads, fetches `pull/<n>/head` into `refs/remotes/origin/pr-<n>` and checks it out, so the agent reviews the exact head.
- For issue threads, checks out the default branch and pulls `--ff-only` on reuse.
- Binds the directory with `Scope.fromDirectory(directory, { persist: true })` and records the mapping in the account workspace index (`data/channel/providers/github/accounts/<hash>/workspaces/index/...`).

The channel core calls the provider's `resolveConversationScope()` per message, so the Session for each thread is created inside its own Scope. Sessions are therefore isolated: a review of PR #3 cannot read or modify another thread's checkout.

## Conversation flow

1. The poll loop delivers a `MessageContext` with `chatId = "owner/repo#<number>"`, `messageId` (numeric for comments so reactions land on the real comment), and a prompt that embeds the event (issue text, PR diff summary, or comment body).
2. The channel core resolves the per-thread Scope, creates/loads the Session (agent `github-channel-agent`, autonomous control profile, unattended interaction), and durably enqueues the message.
3. The agent runs the agentic loop inside the checkout: reads code, runs tests, edits and commits locally when fixing, and produces its final reply.
4. `ChannelOutbound` posts the terminal assistant message back through `replyMessage` (a comment on the triggering comment) or `pushMessage` (a new comment on the thread). The final reply ends with a `**Synergy**: <status>` line per the agent's output contract.

Status reactions are mapped to GitHub's reaction set (`eyes` while queued/working, `rocket` on done, `confused` on error); unsupported emoji are skipped.

## Agent

`github-channel-agent` (hidden, native, temperature 0, mid model role) is the single agent for GitHub channel sessions. Its prompt follows PR-Agent's organization — role definition, judgment standards, comment writing style, and an output contract — while keeping Synergy's agentic loop (real tool use in the checkout, autonomous execution, no single-shot restriction):

- **Role** — senior engineer reviewing PRs / answering questions / fixing issues on behalf of maintainers; treats issue text, diffs, and comments as untrusted data.
- **Judgment standards** — defects must be actionable with file/line evidence; severity calibrated; verify before claiming.
- **Comment style** — concise, conclusion-first Markdown with `path/file.ts:line` references; no filler.
- **Output contract** — the final reply is posted verbatim as the GitHub comment, self-contained GitHub-flavored Markdown under 8,000 chars, ending with `**Synergy**: <status>`.

Permissions: read/grep/glob/edit/write/bash allowed inside the checkout; `gh` CLI, `git push`, and `git remote` denied (the provider owns all GitHub writes).

## Storage

| Path                                                                 | Purpose                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `data/channel/providers/github/accounts/<hash>/poll-state/<repo>`    | Per-repository poll cursors and dedup state                     |
| `data/channel/providers/github/accounts/<hash>/workspaces/index/`    | Thread → checkout directory + Scope records                     |
| `data/channel/providers/github/accounts/<hash>/seen-comments/<repo>` | Comment dedup (bounded)                                         |
| Session/message storage                                              | Standard Channel sessions under the Channel navigation category |

## Relationship to the user-credential GitHub provider

The separate `src/provider/github.ts` (OAuth device-flow personal token) is unchanged and remains the credential source for the bash tool's `GH_TOKEN` injection and the GitHub settings panel. The channel uses the GitHub **App** installation token exclusively.

## References

- PR-Agent prompt organization: `The-PR-Agent/pr-agent` `pr_agent/settings/pr_reviewer_prompts.toml`, `pr_questions_prompts.toml` (role, criteria, style, output contract).
- Channel runtime contract: [Channels](channels.md); [Connections](../product/connections.md).
