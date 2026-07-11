# Plugin Security

Plugin security is a chain of explicit boundaries. No single signature, source label, runtime mode, or permission prompt is sufficient by itself.

## Author Checklist

### Manifest and capabilities

- Keep the descriptor ID, manifest name, package, signature, and registry ID identical.
- Declare every runtime tool and UI surface before code is imported.
- Request the narrowest filesystem, shell, network, MCP, session, workspace, config, secret, task, and hook capabilities.
- Narrow each tool below the plugin-wide capability ceiling.
- Restrict network domains and delegated agent names.
- Put internal helpers behind internal exposure and explicit child tool allowlists.

### Runtime behavior

- Use public SDK services; do not import private Synergy modules or read Synergy storage directly.
- Honor abort signals and host timeouts.
- Avoid background processes or detached work that outlives a call.
- Route shell, files, network, nested tools, and delegated tasks through the host boundary.
- Do not weaken a permission decision in a broad `permission.ask` hook.
- Treat session, workspace, prompt, and tool data as untrusted input.

### Secrets and logs

- Store only plugin-owned credentials in `input.auth`.
- Remember that the current plugin auth store is unencrypted JSON on disk.
- Never put credentials in config, cache, result metadata, attachments, errors, logs, prompts, or marketplace files.
- Redact request headers, URLs, command lines, and third-party error bodies.
- Do not package `.env`, local auth files, signing private keys, or development caches.

### UI

- Prefer declarative settings and renderer fallbacks when custom JavaScript is unnecessary.
- Package static reviewed SVG/CSS assets; do not inject unsanitized HTML.
- Do not bundle Solid or depend on an unsupported Solid runtime path.
- Do not use browser-local storage as a secret store.
- Constrain remote resources and frames to declared domains.
- Preserve keyboard, focus, accessibility, and safe link behavior.

### Supply chain

- Build from a clean source tree and inspect the generated `dist/` contents.
- Validate runtime discovery and package integrity.
- Sign the exact tarball you publish.
- Keep the signing private key outside the repository and release assets.
- Pin and review dependencies; remove unused runtime packages.
- Publish a new version for every artifact change.

## Reviewer Checklist

Before approval, compare:

1. The stated product behavior with the manifest contributions.
2. Broad permissions with every declared tool capability.
3. Hooks with the data or decisions they can observe or mutate.
4. Network domains with the services the plugin claims to use.
5. Delegated agents and internal tools with the plugin workflow.
6. Source, version, archive hash, signer, manifest hash, and permissions hash.
7. Requested runtime mode with source trust and risk.
8. UI exports and assets with declared surfaces.

Permission changes are security changes. A seemingly small update that adds global config access, a prompt transform, shell, file write, new domains, or broader task delegation deserves a fresh review.

## Isolation Expectations

Process mode provides the strongest current runtime separation, but the host bridge is still the authority for privileged operations. Worker mode shares more process resources and is unsuitable for some capabilities. In-process plugins execute inside the server and should be limited to built-in, official, or author-controlled local code under the configured policy.

A `sandbox` trust result does not itself guarantee OS-level containment for every language action. Choose process mode, keep capabilities narrow, and avoid ambient APIs. Conversely, `trusted-import` means the host accepts importing the code; it does not bypass the manifest, session control profile, tool permission gate, or sandbox used by an operation.

## Failure and Revocation

If a plugin is suspect:

```bash
synergy plugin runtime stop <id>
synergy plugin runtime status <id>
synergy plugin doctor
```

Stopping an isolated runtime is immediate but temporary. Remove the plugin with `synergy plugin remove <id>`, rotate any credentials it could access, and inspect the plugin audit and Synergy logs. Deleting a cache directory alone does not revoke credentials or approval.

Do not publish security vulnerabilities as public issues. Follow the repository's security reporting policy in [`.github/SECURITY.md`](../../.github/SECURITY.md).

## Before Release

```bash
synergy-plugin validate --runtime-discovery
synergy-plugin test
synergy-plugin build
synergy-plugin pack
synergy-plugin sign <archive>
```

Inspect `plugin.normalized.json`, `permissions.summary.json`, `integrity.json`, the archive file list, and the generated registry entry before distribution.
