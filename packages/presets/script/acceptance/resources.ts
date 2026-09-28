import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { SecretVault } from "@ericsanchezok/synergy-harness/secrets/vault"
import type { RemoteLab } from "./remote-protocol"

export async function configureRemote(lab: RemoteLab) {
  async function tls(files: RemoteLab["engineTLS"]) {
    const refs = await Promise.all(
      [files.cert, files.key, files.ca].map(
        async (file) => (await SecretVault.register(await Bun.file(file).text(), { kind: "user" })).id,
      ),
    )
    return { certRef: refs[0]!, keyRef: refs[1]!, caRef: refs[2]! }
  }
  await Config.updateGlobal({
    resources: {
      defaultEnvironment: null,
      environments: {
        remote: {
          provider: "docker",
          spec: {
            image: lab.image,
            memoryBytes: 1_073_741_824,
            cpus: 2,
            pids: 128,
            mounts: [],
            host: {
              endpoint: lab.endpoint,
              engineTLS: await tls(lab.engineTLS),
              executionTLS: await tls(lab.executionTLS),
              executionHostname: lab.hostname,
              publishHostIP: lab.hostname,
            },
          },
        },
      },
      stores: { files: { provider: "local", spec: { namespace: "acceptance" } } },
    },
  })
}
