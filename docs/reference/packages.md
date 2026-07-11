# Package Map

Synergy is a Bun monorepo. Package ownership is intentionally split between the runtime, clients, public SDKs, protocol hosts, and build tooling.

| Path                             | Package / responsibility                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/synergy`               | `synergy`: core runtime, server, CLI, sessions, agents, tools, permissions, integrations, orchestration, persistence  |
| `packages/app`                   | `@ericsanchezok/synergy-app`: Solid/Vite Web workbench and product UI                                                 |
| `packages/desktop`               | `@ericsanchezok/synergy-desktop`: Electron shell, managed local runtime, native Browser, packaging, signing, updating |
| `packages/plugin`                | `@ericsanchezok/synergy-plugin`: public plugin SDK, manifest/contribution types, hooks, permissions, UI contracts     |
| `packages/plugin-kit`            | `@ericsanchezok/synergy-plugin-kit`: standalone `synergy-plugin` authoring/build/validation CLI                       |
| `packages/sdk/js`                | `@ericsanchezok/synergy-sdk`: generated and hand-written TypeScript client/server helpers                             |
| `packages/synergy-link`          | `@ericsanchezok/synergy-link`: remote Link host and CLI                                                               |
| `packages/synergy-link-protocol` | `@ericsanchezok/synergy-link-protocol`: typed Link envelopes, sessions, Bash, process, errors, and client contracts   |
| `packages/ui`                    | `@ericsanchezok/synergy-ui`: shared UI components, semantic icons, rendering, styles, themes, plugin UI surfaces      |
| `packages/util`                  | `@ericsanchezok/synergy-util`: shared errors, protocol helpers, policy and utility primitives                         |
| `packages/script`                | `@ericsanchezok/synergy-script`: build and release utilities                                                          |

## Runtime Boundaries

`packages/synergy` owns product truth for server behavior. Web clients call its routes through `@ericsanchezok/synergy-sdk`; internal product routes should not be duplicated as hand-written frontend fetches.

`packages/app` owns Web interaction and workbench behavior. Durable visual and UX principles live in `packages/app/PRODUCT.md`, while reusable primitives belong in `packages/ui`.

`packages/desktop` owns native capabilities and production hosting, not a separate session model. Its managed mode launches the packaged server; its Browser native presentation executes the shared Browser command protocol.

## Public Extension Boundaries

Plugin authors compile against `packages/plugin`, not runtime internals. `packages/plugin-kit` consumes that SDK to create, build, validate, sign, pack, test, and publish plugin artifacts.

The TypeScript SDK is generated from server OpenAPI metadata. When routes or route schemas change, run `./script/generate.ts` and include the generated SDK update.

Synergy Link transport and host code depend on the standalone protocol package so local runtime, remote host, and third-party consumers validate the same versioned envelopes.

## Package Validation

The root package catalog pins shared dependency versions. `bun run monorepo:check` validates workspace consistency. `bun run package:check` builds and validates publishable package manifests and TypeScript resolution with publint and attw.

See [Development](development.md) and [Open-source quality](../operations/open-source-quality.md).
