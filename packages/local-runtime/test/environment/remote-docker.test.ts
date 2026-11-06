import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { dockerEnvironment } from "../../src/environment/docker"

const image = process.env.SYNERGY_TEST_DOCKER_ENVIRONMENT_IMAGE
test.skipIf(!image || process.platform === "win32")(
  "remote Docker Engine and execution endpoints share the lifecycle over authenticated TLS",
  async () => {
    await using tmp = await tmpdir()
    const keyFile = path.join(tmp.path, "key.pem")
    const certificateFile = path.join(tmp.path, "certificate.pem")
    const certificate = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certificateFile,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    if ((await certificate.exited) !== 0) throw new Error(await new Response(certificate.stderr).text())
    const [cert, key] = await Promise.all([Bun.file(certificateFile).text(), Bun.file(keyFile).text()])
    const endpoint = new URL(process.env.SYNERGY_TEST_DOCKER_HOST ?? "unix:///var/run/docker.sock")
    if (endpoint.protocol !== "unix:") throw new Error("TLS Docker integration expects a local Unix daemon socket")
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert, key, ca: cert, requestCert: true, rejectUnauthorized: true },
      async fetch(request) {
        const url = new URL(request.url)
        return fetch(`http://localhost${url.pathname}${url.search}`, {
          unix: endpoint.pathname,
          method: request.method,
          headers: { "content-type": "application/json" },
          body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
        })
      },
    })
    const provider = dockerEnvironment({
      endpoint: `https://localhost:${proxy.port}`,
      engineTLS: { ca: cert, cert, key },
      executionTLS: { cert, key },
      executionHostname: "localhost",
    })
    try {
      await using runtime = await testRuntime({ register: () => EnvironmentProviders.register(provider) })
      await runtime.run(async () => {
        const environment = await Environment.bind({
          scopeID: "scope",
          ownerID: "tls",
          provider: "docker",
          spec: { image: image! },
        })
        try {
          let operation = await EnvironmentExecution.start({
            id: "tls-command",
            scopeID: "scope",
            environmentID: environment.id,
            command: {
              command: "/bin/sh",
              args: ["-c", "printf authenticated"],
              cwd: "/tmp",
              env: {},
              useRoots: [],
            },
          })
          for (let attempt = 0; operation.state !== "exited" && attempt < 300; attempt++) {
            await Bun.sleep(20)
            operation = await EnvironmentExecution.reconcile(operation.id, "scope")
          }
          expect(operation.status?.exitCode).toBe(0)
          await EnvironmentExecution.complete(operation.id, "scope")
          expect(
            (await EnvironmentExecution.output(operation.id, "scope"))
              .map((chunk) => Buffer.from(chunk.data, "base64").toString())
              .join(""),
          ).toBe("authenticated")
          await Environment.deallocate(environment.id, { scopeID: "scope" })
        } finally {
          const current = await Environment.get(environment.id, "scope")
          if (current.allocation) await provider.deallocate(Environment.requestOf(current))
        }
      })
    } finally {
      await proxy.stop(true)
    }
  },
  120_000,
)
