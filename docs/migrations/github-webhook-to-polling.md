# GitHub Webhook to Polling Migration

Synergy replaced its inbound GitHub App webhook endpoint with outbound GitHub REST API polling. This is an intentional clean break: the host no longer exposes `POST /integrations/github/webhook`, accepts GitHub webhook signatures, or uses `SYNERGY_GITHUB_WEBHOOK_SECRET`.

For current behavior and configuration, see [GitHub Integration](../architecture/github-shadow.md) and [Configuration](../reference/configuration.md#github-integration).

## Operator Cutover

1. Keep `SYNERGY_GITHUB_APP_ID` and `SYNERGY_GITHUB_APP_PRIVATE_KEY` configured. Polling uses the App JWT to resolve each repository installation and obtain short-lived installation tokens.
2. Ensure the GitHub App installation can read repository issues, pull requests, Actions workflow runs, and repository metadata for every configured repository. Existing fix and review workflows still need their write permissions.
3. Configure at least one repository through `github.watchedRepositories` or an enabled fix/review workflow `repositoryMapping`.
4. Remove the webhook URL and webhook secret from the GitHub App settings. Synergy no longer listens for or validates deliveries.
5. Remove `SYNERGY_GITHUB_WEBHOOK_SECRET` from the runtime environment.
6. Start or reload Synergy and verify that `data/github/poll-state/` contains one state record per configured repository after the first successful cycle.

Polling is enabled by default whenever `github.enabled` is true. To stage the cutover without outbound GitHub calls, set:

```jsonc
{
  "github": {
    "enabled": true,
    "polling": { "enabled": false },
  },
}
```

Re-enable polling after credentials, installation permissions, and repository selection are ready.

## Baseline and Delivery Semantics

The first successful cycle establishes a repository baseline and does not replay historical issues, pull requests, or completed workflow runs. Later cycles query overlapping time windows and synthesize deterministic delivery GUIDs, so repeated API results are durably deduplicated by the existing delivery store.

Poll state uses separate cursors for issue/pull-request updates and workflow-run creation times. Issue history is not retained in poll state; open pull requests and a bounded recent closed-PR history support transition detection; only incomplete workflow runs remain pending.

Existing `data/github/deliveries/`, CI failure state, and runtime workflow anchors remain valid. No webhook-to-poll-state data migration is attempted because webhook deliveries do not contain a complete repository snapshot or safe cursor baseline.

## API and SDK Breaks

The following contracts were removed:

- `POST /integrations/github/webhook`
- unauthenticated GitHub CORS bypass behavior
- HMAC verification and raw-body handling for GitHub webhooks
- `GitHubWebhookResponse` in the OpenAPI schema and generated TypeScript types
- generated JavaScript SDK `Github` and `Webhook` classes for the removed endpoint
- `SYNERGY_GITHUB_WEBHOOK_SECRET`

Clients calling the former endpoint must stop sending deliveries; there is no replacement inbound route. Repository events now enter Synergy only through its outbound poll runtime.

## Configuration Compatibility

`github.polling` adds these fields: `enabled`, `intervalMs`, `overlapWindowMs`, `pageSize`, and `maxPages`. Defaults are applied when the object is omitted. A configuration with both `github.enabled: true` and polling enabled is now invalid unless at least one watched or workflow-mapped repository is present.
