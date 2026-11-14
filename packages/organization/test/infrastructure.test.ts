import { expect, test, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { parseOrganizationConfiguration } from "../src/configuration"
import { loadOrganizationInfrastructure } from "../src/infrastructure"

test.skipIf(process.platform === "win32")(
  "a credential made public before opening cannot authorize the actual descriptor",
  async () => {
    const isolation = await createIsolatedTestEnv()
    const file = path.join(isolation.env.SYNERGY_TEST_ROOT!, "raced-postgres-url")
    const secret = "private-opening-race"
    await fs.writeFile(file, `postgres://operator:${secret}@127.0.0.1:5432/organization`, { mode: 0o600 })
    const before = await fs.stat(file)
    const open = fs.open.bind(fs)
    let raced = false
    const barrier = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === file) {
        raced = true
        await fs.chmod(file, 0o644)
      }
      return open(...args)
    })
    try {
      const result = await loadOrganizationInfrastructure({
        version: 1,
        database: { backend: "postgres", urlFile: file, namespace: "organization", maxConnections: 2 },
      }).catch((error: unknown) => error)
      expect(raced).toBe(true)
      expect((await fs.stat(file)).ino).toBe(before.ino)
      expect(result).toMatchObject({ data: { reason: "credential_file" } })
      expect(String(result)).not.toContain(secret)
    } finally {
      barrier.mockRestore()
      await isolation.dispose()
    }
  },
)

test("dedicated infrastructure configuration resolves private files without loading personal profiles", async () => {
  const isolation = await createIsolatedTestEnv()
  try {
    const credential = path.join(isolation.env.SYNERGY_TEST_ROOT!, "postgres-url")
    await fs.writeFile(credential, "postgres://operator:private-password@127.0.0.1:5432/organization", { mode: 0o600 })
    const configuration = parseOrganizationConfiguration(
      Buffer.from(
        JSON.stringify({
          organization: {
            infrastructure: {
              version: 1,
              database: { backend: "postgres", namespace: "organization", urlFile: credential },
              environments: {
                execution: {
                  provider: "docker",
                  host: { endpoint: "unix:///var/run/docker.sock" },
                  spec: { image: "synergy-execution:test" },
                },
              },
            },
          },
        }),
      ),
      "configuration",
    )
    const selected = await loadOrganizationInfrastructure(configuration.infrastructure)
    expect(selected.database).toMatchObject({ backend: "postgres", namespace: "organization", maxConnections: 2 })
    expect(selected.database?.url).toContain("private-password")
    expect(selected.cloud?.environmentProfiles?.execution.provider).toBe("organization-docker-execution")
    expect(selected.cloud?.environmentProviders?.[0].id).toBe("organization-docker-execution")
    expect(JSON.stringify(configuration)).not.toContain("private-password")
  } finally {
    await isolation.dispose()
  }
})

test("credential references reject public permissions, links, malformed secrets and relative paths without exposing bytes", async () => {
  const isolation = await createIsolatedTestEnv()
  const secret = "private-invalid-credential"
  try {
    const file = path.join(isolation.env.SYNERGY_TEST_ROOT!, "credentials")
    await fs.writeFile(file, secret, { mode: 0o644 })
    const spec = {
      version: 1 as const,
      database: { backend: "postgres" as const, namespace: "organization", urlFile: file, maxConnections: 2 },
    }
    for (const state of ["permissions", "invalid", "link"] as const) {
      if (state === "invalid") await fs.chmod(file, 0o600)
      if (state === "link") {
        await fs.rename(file, file + ".real")
        await fs.symlink(file + ".real", file)
      }
      const error = await loadOrganizationInfrastructure(spec).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain(secret)
    }
    expect(() =>
      parseOrganizationConfiguration(
        Buffer.from(
          JSON.stringify({
            organization: { infrastructure: { ...spec, database: { ...spec.database, urlFile: "relative" } } },
          }),
        ),
        "configuration",
      ),
    ).toThrow()
  } finally {
    await isolation.dispose()
  }
})

test("object profiles retain configured names and remote Docker rejects missing Execution TLS before allocating", async () => {
  const isolation = await createIsolatedTestEnv()
  let requests = 0
  using endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++
      return new Response()
    },
  })
  try {
    const file = path.join(isolation.env.SYNERGY_TEST_ROOT!, "object-credentials")
    await fs.writeFile(file, JSON.stringify({ accessKeyId: "private-access", secretAccessKey: "private-secret" }), {
      mode: 0o600,
    })
    const configuration = {
      version: 1 as const,
      stores: {
        team: {
          provider: "s3" as const,
          bucket: "team",
          region: "us-east-1",
          endpoint: endpoint.url.origin,
          credentialsFile: file,
        },
      },
    }
    const selected = await loadOrganizationInfrastructure(configuration)
    expect(selected.cloud?.workspaceProfiles).toEqual({ team: { blobStore: "team" } })
    expect(Object.keys(selected.cloud?.blobStores ?? {})).toEqual(["team"])
    await expect(
      loadOrganizationInfrastructure({
        version: 1,
        environments: {
          execution: {
            provider: "docker",
            spec: { image: "execution", memoryBytes: 1073741824, cpus: 1, pids: 256, mounts: [] },
            host: { endpoint: endpoint.url.origin, executionHostname: "remote.example" },
          },
        },
      }),
    ).rejects.toMatchObject({ data: { reason: "composition" } })
    expect(requests).toBe(0)
    await fs.writeFile(file, "invalid-private-secret", { mode: 0o600 })
    const invalid = await loadOrganizationInfrastructure(configuration).catch((error: unknown) => error)
    expect(invalid).toMatchObject({ data: { reason: "credential_content" } })
    expect(String(invalid)).not.toContain("invalid-private-secret")
  } finally {
    await isolation.dispose()
  }
})
