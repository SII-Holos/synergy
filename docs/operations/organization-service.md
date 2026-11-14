# Independent organization service

This runbook covers the `synergy-org` executable and the minimal service Compose deployment. The service owns organization accounts, authorization, metadata and publications; Agent execution runs in independently enrolled member or hosted Runtimes. Read [organization architecture](../architecture/organization.md) for ownership and [the deployment decision](../decisions/implemented/architecture/2026-11-12-ship-an-independent-organization-service-entry.md) for executable composition.

## Install published packages outside a checkout

Install Bun 1.4.3 or newer. Select a published release containing `synergy-org`, set `SYNERGY_VERSION` to its version, and install both matching packages in a dedicated application directory:

```sh
mkdir -p organization-service
cd organization-service
bun init -y
bun add --exact --ignore-scripts "@ericsanchezok/synergy-organization@${SYNERGY_VERSION:?Set a published release version}" "@ericsanchezok/synergy-cli@${SYNERGY_VERSION}"
./node_modules/.bin/synergy-org --help
```

Choose an absolute dedicated Home owned by the service OS account. Keep the application directory and Home separate so package upgrades cannot replace data. The service never selects the personal installation or reads feature preferences. Do not reuse a member Runtime Home.

```sh
export SYNERGY_HOME=/absolute/organization-home
mkdir -m 700 /absolute/private-bootstrap
./node_modules/.bin/synergy-org init --output /absolute/private-bootstrap/initialization.json
./node_modules/.bin/synergy-org serve --origin https://organization.example.org --hostname 127.0.0.1 --port 4080
```

Initialization writes its single-use token only to the new mode-0600 file; stdout contains readiness metadata. Existing output files are rejected. Use the generated Organization SDK's `orgSetup.bootstrap` operation with this token to create the first owner, then remove the private token file. Register the actual Web/Desktop client using the [organization connection setup](../../packages/organization/README.md). The service can serve a separately built authorization page through `serve --web /absolute/web-directory`; that directory is not part of the minimal service image.

## Invite a member

Use an administrator's login and an absolute private password file. One final newline is ignored; other password whitespace is preserved. The command does not require a local Home. Run the same operation through `synergy org invite` in a full installation or through the independent executable:

```sh
./node_modules/.bin/synergy-org invite \
  --origin https://organization.example.org \
  --login-name owner \
  --password-file /absolute/private/owner-password \
  --role member \
  --output /absolute/private/new-member-invitation.json
```

Use `--role admin` only when granting administrator access. Add `--ca-file /absolute/private/organization-ca.pem` for a private CA; HTTPS redirects are rejected. Password and CA files follow the same private regular-file checks as infrastructure credentials. The output must not exist; its parent directory must already be writable. The command publishes and syncs its private marker before any HTTP request, signs in, issues one invitation and attempts to revoke that login. Stdout contains role, expiry, output path and `loginRevoked`, never the token. A false `loginRevoked` requires revoking that temporary login through account management.

Read a successful output's `token` through a trusted private channel, then remove the file when it is no longer needed. Retain failed or unknown output until the outcome is understood. Repeating a command with that path makes no HTTP request. A response can be lost after issuance; inspect and, if needed, revoke the existing invitation through invitation management before using a new output path. The command never automatically retries issuance. The [invitation decision](../decisions/implemented/feature/2026-11-13-issue-invitations-through-the-organization-cli.md) records these guarantees.

## Build an image from release archives

On a Linux build host, use the standard workspace package build and native assets for the target architecture. The [deployment CI workflow](../../.github/workflows/organization-deployment.yml) builds its native helper, packs the same release packages, verifies an external installation, and builds and runs the container without publishing it.

```sh
bun -e 'import {packWorkspace} from "./script/pack-workspace"; await packWorkspace(["packages/organization","packages/cli"], ".artifacts/organization-packages")'
bun script/organization-install-check.ts .artifacts/organization-packages
bun script/organization-image.ts .artifacts/organization-packages .artifacts/organization-image x64
docker build -t synergy-organization:local .artifacts/organization-image
bun script/organization-compose-check.ts synergy-organization:local
```

Image staging requires a new output directory and matching Linux glibc native archive. Use `arm64` with corresponding native artifacts for an ARM64 image. Staging copies installed package content and release metadata; it does not copy the installer Home, registry configuration or credentials. A daemon is required for the final two commands. An image build or Compose run that was skipped is not container acceptance.

## Start Compose

Copy [compose.yml](../../packages/organization/deploy/compose.yml) and [environment.example](../../packages/organization/deploy/environment.example) to the deployment directory. Save the environment file as `.env`, set an exact image tag or digest, the public HTTPS origin, and an absolute private bootstrap directory. The image uses UID/GID 1000; create that bootstrap directory with mode 0700 and ownership 1000:1000. The named data volume inherits the same service ownership.

```sh
docker compose config --quiet
docker compose run --rm initialize
docker compose up -d --wait organization
curl --fail http://127.0.0.1:4080/org/v1/ready
```

Run initialization once for a fresh deployment and retain the named data volume across image replacement. Do not start two service processes against the same Home. The service prints one JSON readiness record containing its organization and deployment identities, local listener address and `executesAgents: false`.

## TLS, ports and probes

Terminate TLS at the reverse proxy and forward to the loopback listener on port 4080. Configure the proxy to forward WebSocket upgrades for enrolled Runtime connections and preserve the public hostname. The supplied `--origin` must exactly equal the public HTTPS origin, without a trailing slash or path; it is not the internal HTTP listener URL. Keep the service port bound to loopback unless a separately secured private network connects the proxy.

`GET /org/v1/live` reports process liveness without storage admission. `GET /org/v1/ready` reports whether the service can accept work and returns 503 during native maintenance or recovery holds. `/org/v1/health` provides the readiness-compatible probe. Use readiness for proxy admission and Compose health, and liveness for diagnosing an alive process during maintenance.

The Home's `.synergy` directory contains its native identity, configuration, storage and publication bytes. Persist the entire Home, keep its service-only access permissions, and store bootstrap files and recovery keys separately. The minimal deployment needs no model directory, Docker socket, privileged container, Desktop application or Agent worker.

## Upgrade and recovery

Retain the old image digest and package lockfile before replacement. Stop admission at the proxy, stop the service gracefully, and preserve its persistent volume. Install both packages at the same selected version or replace the image without changing the volume, then wait for readiness and verify the retained organization identity. Home reader upgrades require the service owner's frozen maintenance flow; an unsupported reader fails closed instead of reinitializing storage. Never run `init` to repair a retained deployment.

For an established ordinary format-two Home using writable SQLite and local artifacts, stop its supervisor and drain native resources, then run the explicit reader upgrade with one stable request identifier:

```bash
SYNERGY_HOME=/absolute/service-home synergy-org upgrade --request-id environment-reader-upgrade
```

The full installation exposes the same operation as `synergy org upgrade`. Retry the same request after an interrupted command; it reconciles the original operation instead of starting another one. Failed or cancelled work retains its native hold. A successful JSON receipt reports `upgrade-complete`, `restartRequired: true` and `executesAgents: false`; restart through the normal supervisor and verify readiness separately. Unsupported native ownership, PostgreSQL and restored format-three Homes require their owning upgrade flow. Preserve the held Home when a partial or invalid marker requires recovery; do not rewrite its metadata or clear its maintenance records.

Consistent encrypted backup and recovery use the [native maintenance and recovery owners](../architecture/organization.md), including current-policy reconciliation and source retirement. The [administrative commands](#encrypted-backup-and-held-restoration) capture encrypted native checkpoints and install a held target. Filesystem copying a live SQL database does not establish a recoverable deployment. Do not use `docker compose down --volumes` during an upgrade. The Compose acceptance script uses that operation only for its own temporary test project.

## Encrypted backup and held restoration

Create a private recovery key file with permissions `0600`. Its version-one JSON contains a current key version and a map of canonical base64-encoded 32-byte keys. Retain older versions for archives encrypted with those keys; keep this file independently of the archive:

```json
{ "version": 1, "current": "recovery-1", "keys": { "recovery-1": "<base64-encoded-32-byte-key>" } }
```

Stop the selected service through its normal supervisor before taking exclusive ownership. Backup opens its established Home, freezes native participants and seals a new encrypted directory. Supply the service's exact public `--origin` when registered client authentication requires it:

```sh
SYNERGY_HOME=/absolute/service-home ./node_modules/.bin/synergy-org backup --output /absolute/new-backup --key-file /absolute/private/recovery-keys.json --origin https://organization.example.org
```

Output reports verified archive metadata and namespace checkpoint coverage. A registered Hosted namespace without its actual capture participant, or unsupported external-resource data, blocks the operation; it does not produce a complete archive. The original Home and archive remain separate. Restart the service through its normal supervisor after capture finishes.

Restore service-only archive bytes into an independent target Home. Choose one UUID as `--restore-id` and retain it for exact retries:

```sh
SYNERGY_HOME=/absolute/restoration-home ./node_modules/.bin/synergy-org restore --input /absolute/new-backup --key-file /absolute/private/recovery-keys.json --restore-id 267aa4b3-4872-4308-b842-472f7d595b6f
```

Archive authentication and supported inventory checks precede target initialization. Output `state: recovery-held` means native bytes and inactive signing material are installed; `executionEnabled` remains false. The target cannot serve or Continue until original current-policy, source-retirement and writer owners complete fresh publication. Exact retries preserve the same installation and key. This command refuses multi-namespace archives without their original installation participants; it cannot recover missing key material or bypass unknown writers. See [administrative ownership](../decisions/implemented/feature/2026-11-13-install-organization-backups-through-original-native-owners.md).

### Explicit service recovery

After held restoration, `recover` verifies final current authority and permanently retires the original service Source before publishing the same Target. Stop that Source through its normal supervisor first. Use the original archive and restore UUID, and keep the independent private work directory for exact retries:

```sh
SYNERGY_HOME=/absolute/restoration-home ./node_modules/.bin/synergy-org recover --input /absolute/new-backup --key-file /absolute/private/recovery-keys.json --restore-id 267aa4b3-4872-4308-b842-472f7d595b6f --source-home /absolute/service-home --source-origin https://organization.example.org --work /absolute/private/recovery-work --origin https://recovered.example.org
```

Supply `--source-origin` when the original effective client settings require it. `--origin` selects the recovered service's exact HTTPS origin. The work directory retains authenticated fixed H1 archives and the original retirement Reference; it cannot grant recovery authority by itself. Retry with the same arguments and retained material after an unknown result. Incomplete work stays blocked rather than creating another request or signing key.

Output `state: ready` confirms ordinary startup and readiness for the fresh deployment; this short command does not leave a server running. Start the recovered Target with `serve`. The original Source remains permanently retired, and no Agent task is continued. Changed, missing or corrupt canonical binaries block before retirement; this path supports stable service-only native data, including unchanged sealed material, Skill selections and published Artifact history, and refuses unsupported multi-namespace, Library and external-writer owners. See [explicit recovery](../decisions/implemented/feature/2026-11-13-recover-service-authority-through-an-explicit-cli.md), [binary verification](../decisions/implemented/bug-fix/2026-11-13-verify-fixed-namespace-binaries-before-source-retirement.md), [sealed knowledge recovery](../decisions/implemented/feature/2026-11-13-recover-exact-sealed-organization-knowledge.md) and [Artifact history recovery](../decisions/implemented/feature/2026-11-13-recover-exact-published-artifact-history.md).

## Additional infrastructure

The executable reads optional `organization.infrastructure` from its dedicated `150-organization.jsonc`. Start from [infrastructure.example.jsonc](../../packages/organization/deploy/infrastructure.example.jsonc), remove unused entries, and set private file references for each backend. The service package's `./infrastructure` export provides `loadOrganizationInfrastructure()` for programmatic hosts. No personal resource configuration is read.

PostgreSQL reads its URL from `database.urlFile` and uses an explicit stable `namespace`; `init` and `serve` require the same configuration. Object credentials are JSON containing `accessKeyId`, `secretAccessKey` and optional `sessionToken`. Every credential, certificate and key must be an absolute regular file, at most 64 KiB, without group/other permissions on POSIX. Match its owner to the service user. Rotate private files and restart to apply changes; JSONC stores references only.

Store names become Workspace profile names. Environment names become Docker profiles backed by `organization-docker-<name>` providers. Administrators expose profiles through the existing resource API and grant account/project use. Selecting a profile does not allocate compute. Docker's native owner creates each allocation's target, credential, container, readiness and drainage. Build its image through `bun packages/local-runtime/script/build-execution-host.ts --image <tag>` and configure that exact tag. Remote Engine and Execution Host traffic requires configured TLS; the service needs neither a local Docker socket nor an unconditional executor container.

The [infrastructure Compose override](../../packages/organization/deploy/compose.infrastructure.yml) mounts configuration and private files into initialization and serving. Independent `postgres` and `objects` profiles provide persistent backends with loopback ports. MinIO's loopback HTTP supports host-side development acceptance; service containers use a separately secured HTTPS object endpoint. Preserve SQL/object volumes, namespace and object prefix together. [environment.infrastructure.example](../../packages/organization/deploy/environment.infrastructure.example) lists deployment paths. Initialize private MinIO client configuration before running `object-initialize`. The object profiles build the original MinIO and mc release versions locally from official GitHub assets, with architecture-specific SHA256 checks and the original server entrypoint. Their [build definition](../../packages/organization/deploy/Dockerfile.objects) and [release provenance](../../packages/organization/deploy/minio-release-provenance.json) support Linux amd64 and arm64 without requiring access to retired MinIO image registries; first use needs HTTPS access to the pinned base image, Debian package archive and GitHub assets.

```sh
docker compose -f compose.yml -f compose.infrastructure.yml --profile postgres up -d --wait postgres
docker compose -f compose.yml -f compose.infrastructure.yml run --rm initialize
docker compose -f compose.yml -f compose.infrastructure.yml up -d --wait organization
```

`bun script/organization-infrastructure-check.ts synergy-execution-host:local` provisions its own temporary PostgreSQL/MinIO project and private credentials. It checks actual SQL restart identity, object bytes and an allocated Execution Host running a command, then removes only its own containers and volumes. External composition still requires actual target reconstruction and coverage for native backup/restore; the existing guard rejects unsupported composition. Startup and health do not establish recoverability.

## Register and serve a Runtime

Install the matching organization Runtime package to obtain `synergy-org-runtime`; a full product installation exposes the same commands under `synergy org-runtime`. Registration uses a private JSON request on stdin and an absolute parent directory. A member identity contains `orgID`, `accountID` and `deviceID`; a hosted identity contains `orgID` and `hostID`:

```json
{
  "version": 1,
  "origin": "https://organization.example.org",
  "identity": { "orgID": "organization-id", "hostID": "team-host" }
}
```

Save the request in a private file; add `ca` containing the trusted PEM certificate when using a private CA. Prepare its Home and public key:

```sh
./node_modules/.bin/synergy-org-runtime register --base-directory /absolute/machine-homes < /absolute/private/register.json
```

The returned `home` is qualified by the complete machine identity. Give its `publicKey` to the existing generated `orgRuntime.registerHosted` operation, or `registerMember` under the actual member account. Add the exact returned ticket as `ticket` in the same private registration request, then repeat the command once to enroll. No ticket or private key is printed. Repeating preparation without a ticket reports the retained enrollment without a network request. An uncertain response is not automatically retried; the original exact ticket can explicitly reconcile through the enrollment owner. Different keys or deployment identities require explicit recovery.

Start the enrolled machine with the existing version-one launch request described below, including its matching identity/incarnation, a nonzero loopback port, a fresh 64-hex bearer and optional CA. Tickets are optional after successful enrollment. `state: active` in registration output describes the retained receipt, not live connectivity or permission to run a Session.

```sh
SYNERGY_HOME=/absolute/identity-qualified-home ./node_modules/.bin/synergy-org-runtime serve --kind hosted < /absolute/private/hosted-request.json
```

Use `--kind member` with the matching member request. The command shares supervised startup, readiness and graceful shutdown; it does not start a personal Runtime. Keep request files private and out of logs or command arguments.

## Inspect and retire original native targets

Use `synergy-org-runtime cleanup` on the original enrolled member Home when a cancelled native Handoff retains an inactive destination. The matching full product exposes `synergy org-runtime cleanup`. An active Runtime holding that Home lock blocks the command; cleanup never stops it. Bounded private stdin carries `version: 1`, `identity: { orgID, accountID, deviceID }`, the expected `deploymentIncarnation` and optional trusted PEM `ca`. The service origin and machine key come from the retained Home.

```sh
SYNERGY_HOME=/absolute/identity-qualified-home ./node_modules/.bin/synergy-org-runtime cleanup list --limit 50 < /absolute/private/cleanup.json
```

Follow the returned cursor for another page. To inspect one original target, add its exact returned `descriptor` to the same private request and invoke `cleanup inspect`. Use `cleanup retire` with that descriptor only after inspection identifies the inactive target to release. Retirement submits the original signed cleanup fact through the enrolled service origin. If the acknowledgement is unknown, inspect again; do not create a new descriptor or infer that a timeout released the claim.

List and inspect attach existing storage read-only. Retirement validates its current schema, namespace, manifest and dataset identities before taking the normal writer fence; unfinished migrations or projections require their owning maintenance procedure. The command starts no ordinary member connection or execution services and grants no preparation, activation, new Handoff or Continue authority. See [restricted cleanup](../decisions/implemented/feature/2026-11-13-reconcile-original-machine-targets-through-a-restricted-cli.md).

### Report a retained Source receipt

For an original member Source that already committed cancellation or surrender, add its original `handoffID` to the bounded private version-one identity/deployment/CA request. Run the restricted command on that enrolled Home:

```sh
SYNERGY_HOME=/absolute/identity-qualified-home ./node_modules/.bin/synergy-org-runtime cleanup source-receipt < /absolute/private/source-receipt.json
```

The command attaches existing storage read-only and rechecks its actual primary, artifact owner and stable native Session metadata. Only the terminal receipt can produce a report; a frozen snapshot alone is insufficient. After an unknown proof acknowledgement, a later invocation reconciles the identical fact rather than repeating a native operation. Existing Runtime ownership blocks this command, which never stops that Runtime. Member Source has focused HTTPS acceptance; Hosted Source requires separate verification. See [Source receipt recovery](../decisions/implemented/feature/2026-11-13-reconcile-original-source-terminal-receipts.md).

## Hosted Runtime entry

Supervisors and hosted images use `synergy-org-runtime hosted-runtime` with the same serving lifecycle. For programmatic preparation, `prepareHostedHome({ baseDirectory, identity: { orgID, hostID }, origin })` comes from `./home`; the public CLI follows the [same registration flow](#register-and-serve-a-runtime). Private stdin receives the existing `HostedLaunchRequest` with the prepared identity, deployment incarnation, explicit local port, ephemeral 64-hex bearer, optional CA and optional enrollment ticket. End at EOF; the request is bounded to 64 KiB and never appears in arguments/output. Retained registration permits restart without replaying the ticket. The local listener stays loopback-only.

```sh
SYNERGY_HOME=/absolute/prepared-hosted-home ./node_modules/.bin/synergy-org-runtime hosted-runtime < /absolute/private/hosted-request.json
```

Pack the Runtime together with service and CLI, then select `--hosted` when staging its separate image. The override's `hosted` profile mounts the prepared Home and private request, passing the request on stdin. It never provisions or registers identities implicitly. Give the image user access to both mounts; preserve the hosted Home independently of service/backend volumes.

```sh
bun -e 'import {packWorkspace} from "./script/pack-workspace"; await packWorkspace(["packages/organization","packages/cli","packages/organization-runtime"], ".artifacts/organization-packages")'
bun script/organization-runtime-install-check.ts .artifacts/organization-packages
bun script/organization-deployment-install-check.ts .artifacts/organization-packages
bun script/organization-image.ts .artifacts/organization-packages .artifacts/organization-hosted-image x64 --hosted
docker build -t synergy-organization-hosted:local .artifacts/organization-hosted-image
docker compose -f compose.yml -f compose.infrastructure.yml --profile hosted up -d hosted
```

The deployment CI requires the installed Service/Hosted recovery check in addition to startup checks, using the same archives. It exercises the [original cohort and recovery owners](../decisions/implemented/architecture/2026-11-12-drain-organization-service-before-cohort-capture.md#verification) in a temporary installation outside the checkout; neither a namespace seal nor successful container startup replaces its held installation, original writer retirement and guarded publication requirements.
