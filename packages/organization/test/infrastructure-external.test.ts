import { expect, test } from "bun:test"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { WorkspaceBlobs } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { InfrastructureConfiguration } from "../src/infrastructure-schema"
import { loadOrganizationInfrastructure } from "../src/infrastructure"
import { openOrganizationService } from "../src/service"

const configuration = process.env.SYNERGY_TEST_ORGANIZATION_INFRASTRUCTURE
test.skipIf(!configuration)(
  "configured PostgreSQL, object storage and Docker Execution Host retain their actual owners",
  async () => {
    const isolation = await createIsolatedTestEnv()
    try {
      const spec = InfrastructureConfiguration.parse(await Bun.file(configuration!).json())
      if (!spec.database || !Object.keys(spec.stores ?? {}).length || !Object.keys(spec.environments ?? {}).length)
        throw new Error("External infrastructure acceptance requires all three actual configured backends")
      spec.database.namespace = "organization_" + crypto.randomUUID().replaceAll("-", "")
      let identity: string | undefined
      for (let restart = 0; restart < 2; restart++) {
        await using service = await openOrganizationService({
          home: path.join(isolation.env.SYNERGY_TEST_ROOT!, "service"),
          ...(await loadOrganizationInfrastructure(spec)),
        })
        const deployment = await service.deployment()
        if (identity) expect(deployment.orgID).toBe(identity)
        else identity = deployment.orgID
        expect((await service.fetch(new Request("https://organization.example/org/v1/ready"))).status).toBe(200)
        if (restart) continue
        await service.maintenance.run(async () => {
          const bytes = new TextEncoder().encode("actual object storage " + crypto.randomUUID())
          const hash = WorkspaceTree.hash(bytes)
          for (const name of Object.keys(spec.stores!)) {
            const store = WorkspaceBlobs.get(name)
            await store.put(hash, bytes)
            expect(await store.get(hash, bytes.length)).toEqual(bytes)
          }
          for (const [name, profile] of Object.entries(spec.environments!)) {
            const provider = EnvironmentProviders.get(`organization-docker-${name}`)
            const request = {
              environmentID: "env_" + crypto.randomUUID().replaceAll("-", ""),
              requestID: crypto.randomUUID(),
              generation: 1,
              spec: profile.spec,
            }
            try {
              const allocation = await provider.allocate(request)
              expect(allocation.capabilities).toContain("exec")
              const target = {
                environmentID: request.environmentID,
                allocationID: request.requestID,
                generation: request.generation,
              }
              const executor = await provider.connect!(request, target)
              expect((await executor.describe!()).platform).toBe("linux")
              const command = ExecutionProtocol.Command.parse({
                command: "/bin/sh",
                args: ["-c", "printf organization-infrastructure"],
                cwd: "/tmp",
                env: {},
                useRoots: [],
              })
              const id = crypto.randomUUID()
              let status = await executor.start({ id, target, digest: ExecutionProtocol.digest(command), command })
              for (let attempt = 0; !ExecutionProtocol.terminal(status) && attempt < 300; attempt++) {
                await Bun.sleep(20)
                status = (await executor.status(id)) ?? status
              }
              expect(status.exitCode).toBe(0)
              expect(ExecutionProtocol.terminal(status)).toBe(true)
              expect(
                (await executor.output(id, 0, 100))
                  .map((chunk) => Buffer.from(chunk.data, "base64").toString())
                  .join(""),
              ).toBe("organization-infrastructure")
              await executor.release(id)
            } finally {
              await provider.deallocate(request)
            }
          }
        })
      }
    } finally {
      await isolation.dispose()
    }
  },
  120_000,
)
