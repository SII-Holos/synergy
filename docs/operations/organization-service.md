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

Consistent encrypted backup and recovery use the [native maintenance and recovery owners](../architecture/organization.md), including current-policy reconciliation and source retirement. The minimal executable has no administrative backup/restore command; filesystem copying a live SQL database does not establish a recoverable deployment. Do not use `docker compose down --volumes` during an upgrade. The Compose acceptance script uses that operation only for its own temporary test project.

## Additional infrastructure

The minimal Compose file starts only the independent service. PostgreSQL and cloud providers are explicit programmatic service options; the executable's organization settings cover authentication and Runtime connection policy. Hosted Runtimes consume private supervisor requests, and Docker Execution Hosts retain their own authenticated endpoint and allocation owner. These require a configured integration before an optional profile can provide useful behavior; an unconnected database or object-store container is not a deployment of that feature.
