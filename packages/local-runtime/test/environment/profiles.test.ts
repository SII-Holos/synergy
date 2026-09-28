import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { ResourceProfiles } from "../../src/environment/profiles"
import { DockerProfileSpec } from "../../src/environment/profile-schema"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { EnvironmentProcess } from "@ericsanchezok/synergy-harness/environment/process"

test("API-only composition retains stored Workspaces and advertises no execution profiles", async () => {
  const { testRuntime: harnessRuntime } = await import("@ericsanchezok/synergy-harness/test/support/runtime")
  const { registerLocalRuntime } = await import("../../src/register")
  const { testWorkspaceCoordinator } = await import("../support/runtime")
  await using runtime = await harnessRuntime({
    composition: {
      register: () => registerLocalRuntime({ environment: false, workspaceCoordinator: testWorkspaceCoordinator() }),
    },
  })
  await runtime.run(async () => {
    await Config.updateGlobal({ resources: { stores: { files: { provider: "local", spec: { namespace: "api" } } } } })
    expect(await ResourceProfiles.list()).toMatchObject({
      defaultEnvironment: null,
      environments: [],
      stores: [{ name: "files", provider: "local" }],
    })
    const workspace = await ResourceProfiles.createWorkspace({ scopeID: "home", profile: "files" })
    await WorkspaceContent.write(
      { scopeID: "home", workspaceID: workspace.id },
      { path: "api.txt", data: new TextEncoder().encode("api"), expectedVersion: null },
    )
    expect(
      new TextDecoder().decode(await WorkspaceContent.read({ scopeID: "home", workspaceID: workspace.id }, "api.txt")),
    ).toBe("api")
    expect(await Environment.select({ scopeID: "home", ownerID: "api" })).toBeUndefined()
  })
})

test("product resource profiles create durable selections without allocating compute", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await Config.updateGlobal({
      resources: {
        defaultEnvironment: "remote",
        environments: {
          remote: {
            provider: "docker",
            spec: DockerProfileSpec.parse({ host: { endpoint: "unix:///absent/docker.sock" }, image: "executor:test" }),
          },
        },
        stores: { disk: { provider: "local", spec: { namespace: "first" } } },
      },
    })
    const environment = await Environment.select({ scopeID: "home", ownerID: "session" })
    expect(environment).toMatchObject({ provider: "docker", state: "idle", generation: 0 })
    const workspace = await ResourceProfiles.createWorkspace({ scopeID: "home", profile: "disk" })
    const selection = { scopeID: "home", workspaceID: workspace.id }
    await WorkspaceContent.write(selection, {
      path: "data.txt",
      data: new TextEncoder().encode("durable"),
      expectedVersion: null,
    })
    await Config.updateGlobal({
      resources: { defaultEnvironment: null, stores: { disk: { provider: "local", spec: { namespace: "second" } } } },
    })
    expect(new TextDecoder().decode(await WorkspaceContent.read(selection, "data.txt"))).toBe("durable")
    expect(await Environment.select({ scopeID: "home", ownerID: "other" })).toBeUndefined()
    expect((await Environment.get(environment!.id, "home")).spec.image).toBe("executor:test")
    expect(await Environment.uses(environment!.id)).toHaveLength(0)
  })
})

test("resource profiles reject missing names and invalid immutable backend settings", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await expect(ResourceProfiles.createWorkspace({ scopeID: "home", profile: "missing" })).rejects.toThrow("profile")
    await expect(
      ResourceProfiles.createEnvironment({ scopeID: "home", profile: "missing", ownerID: "owner" }),
    ).rejects.toThrow("profile")
    await expect(
      Config.updateGlobal({
        resources: { stores: { invalid: { provider: "local", spec: { namespace: "../escape" } } } },
      }),
    ).rejects.toThrow()
  })
})

test("invalid resource configuration stays visible and cannot silently select native execution", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const file = ConfigDomain.filepath("resources")
    await Bun.write(file, '{"resources": {"defaultEnvironment":')
    Config.global.reset()
    await expect(Environment.select({ scopeID: "home", ownerID: "broken" })).rejects.toThrow()
    await expect(Config.domainGet("resources")).rejects.toThrow()
    expect(await Bun.file(file).exists()).toBe(true)
    expect(await Environment.list("home")).toEqual([])
  })
})

const image = process.env.SYNERGY_TEST_DOCKER_ENVIRONMENT_IMAGE
test.skipIf(!image)(
  "configured Docker and local objects survive compute reclamation through the product composition",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await Config.updateGlobal({
        resources: {
          environments: {
            worker: {
              provider: "docker",
              spec: DockerProfileSpec.parse({
                image,
                host: { endpoint: process.env.SYNERGY_TEST_DOCKER_HOST ?? "unix:///var/run/docker.sock" },
              }),
            },
          },
          stores: { files: { provider: "local", spec: { namespace: "fixture" } } },
        },
      })
      const workspace = await ResourceProfiles.createWorkspace({ scopeID: "home", profile: "files" })
      const environment = await ResourceProfiles.createEnvironment({
        scopeID: "home",
        ownerID: "test",
        profile: "worker",
      })
      const selection = { scopeID: "home", environmentID: environment.id, workspaceID: workspace.id }
      expect(environment.state).toBe("idle")
      try {
        await using resources = await EnvironmentResources.resolve({
          ...selection,
          needs: { execution: "exec", workspace: true },
        })
        const operation = await EnvironmentProcess.prepare({
          id: "configured-execution",
          scopeID: "home",
          resources,
          command: {
            command: "/bin/sh",
            args: ["-c", "printf configured > result"],
            cwd: resources.directory!,
            env: {},
            writableRoots: [resources.directory!],
          },
        })
        operation.child.stdout.resume()
        operation.child.stderr.resume()
        await operation.activate()
        await operation.completion
      } finally {
        await Environment.deallocate(environment.id, { scopeID: "home" })
      }
      expect(new TextDecoder().decode(await WorkspaceContent.read(selection, "result"))).toBe("configured")
      expect((await Environment.get(environment.id, "home")).state).toBe("idle")
    })
  },
  120_000,
)
