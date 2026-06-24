# Trust, Source, And Isolation

Synergy separates three related decisions:

- plugin source: `local`, `npm`, `git`, `url`, or `official`
- runtime mode: `in-process`, `worker`, or `process`
- UI trust tier: `declarative`, `trusted-import`, or `sandbox`

## Source Detection

Source is derived from the install spec and lockfile, not from package name:

| Spec                         | Source  |
| ---------------------------- | ------- |
| `file:///path/to/plugin`     | `local` |
| `file:///path/to/plugin.tgz` | `local` |
| `npm-package`                | `npm`   |
| `github:owner/repo`          | `git`   |
| `git+ssh://...`              | `git`   |
| `https://...`                | `url`   |

## Runtime Policy

Trusted local plugins may run `in-process`. Third-party and high-risk plugins normally run in `process`. `worker` is available for isolated plugins that do not require a separate OS process.

The isolated runtime always starts the Synergy plugin runner, which imports the descriptor and proxies tool/hook calls.

## UI Trust

| Tier             | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `declarative`    | Manifest-only metadata; no Web bundle execution needed      |
| `trusted-import` | The Web host can dynamic-import the plugin UI bundle        |
| `sandbox`        | UI should be rendered through sandbox metadata/iframe paths |

Only install sources and approvals that the host trusts should use `trusted-import`. Third-party plugins should default to sandboxed or declarative UI behavior.

## Approval

Trust does not replace permissions. A plugin with trusted source still needs a valid approval record if its manifest requests sensitive capabilities.
