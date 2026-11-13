#!/usr/bin/env bun
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const image = process.argv[2]
if (!image) throw new Error("Usage: bun script/organization-infrastructure-check.ts <built Execution Host image>")
const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-org-infrastructure-"))
const credentials = path.join(root, "credentials")
const client = path.join(root, "client")
await Promise.all([fs.mkdir(credentials, { mode: 0o700 }), fs.mkdir(client, { mode: 0o700 })])
const password = crypto.randomUUID() + crypto.randomUUID()
const accessKeyId = "organization-acceptance"
const secretAccessKey = crypto.randomUUID() + crypto.randomUUID()
for (const [name, value] of Object.entries({
  "postgres-password": password,
  "object-user": accessKeyId,
  "object-password": secretAccessKey,
}))
  await fs.writeFile(path.join(credentials, name), value, { mode: 0o600 })
// Provenance: https://github.com/minio/mc/blob/RELEASE.2025-08-13T08-35-41Z/cmd/config.go
// Local adaptation: use its private version-ten configuration instead of exposing credentials in process arguments.
await fs.writeFile(
  path.join(client, "config.json"),
  JSON.stringify({
    version: "10",
    aliases: {
      deployment: {
        url: "http://objects:9000",
        accessKey: accessKeyId,
        secretKey: secretAccessKey,
        api: "S3v4",
        path: "auto",
      },
    },
  }),
  { mode: 0o600 },
)
const env = {
  ...process.env,
  SYNERGY_ORGANIZATION_IMAGE: "unused-by-backend-acceptance",
  SYNERGY_ORGANIZATION_ORIGIN: "https://organization.example",
  SYNERGY_ORGANIZATION_BOOTSTRAP: root,
  SYNERGY_ORGANIZATION_CONFIG: path.join(root, "configuration.json"),
  SYNERGY_ORGANIZATION_CREDENTIALS: credentials,
  SYNERGY_ORGANIZATION_OBJECT_CLIENT: client,
  SYNERGY_ORGANIZATION_POSTGRES_PORT: "0",
  SYNERGY_ORGANIZATION_OBJECT_PORT: "0",
  SYNERGY_ORGANIZATION_OPERATOR_UID: String(process.getuid?.() ?? 1000),
  SYNERGY_ORGANIZATION_OPERATOR_GID: String(process.getgid?.() ?? 1000),
  SYNERGY_ORGANIZATION_HOSTED_IMAGE: "unused-by-backend-acceptance",
  SYNERGY_ORGANIZATION_HOSTED_HOME: root,
  SYNERGY_ORGANIZATION_HOSTED_REQUEST: path.join(root, "unused-hosted-request"),
}
const compose = [
  "docker",
  "compose",
  "-f",
  path.resolve(import.meta.dir, "../packages/organization/deploy/compose.yml"),
  "-f",
  path.resolve(import.meta.dir, "../packages/organization/deploy/compose.infrastructure.yml"),
  "-p",
  "synergy-org-infra-" + crypto.randomUUID(),
]
async function run(command: string[]) {
  const child = Bun.spawn([...compose, ...command], { env, stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill("SIGTERM"), 180_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code) throw new Error(`Infrastructure Compose ${command[0]} failed: ${stderr}`)
    return stdout
  } finally {
    clearTimeout(timeout)
  }
}
try {
  await run(["up", "-d", "--wait", "postgres"])
  await run(["up", "-d", "objects"])
  const postgres = (await run(["port", "postgres", "5432"])).trim()
  const objects = (await run(["port", "objects", "9000"])).trim()
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await fetch(`http://${objects}/minio/health/ready`).catch(() => undefined))?.ok) {
      ready = true
      break
    }
    await Bun.sleep(500)
  }
  if (!ready) throw new Error("Object backend did not become ready")
  await run(["run", "--rm", "object-initialize"])
  const urlFile = path.join(credentials, "postgres-url")
  const objectFile = path.join(credentials, "object-credentials.json")
  const databaseURL = `postgres://organization:${password}@${postgres}/organization`
  await fs.writeFile(urlFile, databaseURL, { mode: 0o600 })
  await fs.writeFile(objectFile, JSON.stringify({ accessKeyId, secretAccessKey }), { mode: 0o600 })
  await fs.writeFile(
    env.SYNERGY_ORGANIZATION_CONFIG,
    JSON.stringify({
      version: 1,
      database: { backend: "postgres", namespace: "organization", urlFile },
      stores: {
        objects: {
          provider: "s3",
          bucket: "organization",
          region: "us-east-1",
          endpoint: `http://${objects}`,
          credentialsFile: objectFile,
        },
      },
      environments: {
        execution: {
          provider: "docker",
          host: { endpoint: process.env.SYNERGY_TEST_DOCKER_HOST ?? "unix:///var/run/docker.sock" },
          spec: { image },
        },
      },
    }),
    { mode: 0o600 },
  )
  const acceptance = Bun.spawn([process.execPath, "run", "test"], {
    cwd: path.resolve(import.meta.dir, "../packages/organization"),
    env: {
      ...env,
      SYNERGY_TEST_ORGANIZATION_INFRASTRUCTURE: env.SYNERGY_ORGANIZATION_CONFIG,
      SYNERGY_TEST_POSTGRES_URL: databaseURL,
      SYNERGY_TEST_FILES: JSON.stringify([
        "test/infrastructure-external.test.ts",
        "test/backup/postgres-native.test.ts",
      ]),
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await acceptance.exited) throw new Error("Actual organization infrastructure acceptance failed")
} finally {
  try {
    await run(["down", "--volumes", "--remove-orphans"])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
