import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { cmd } from "@ericsanchezok/synergy-cli/cli/cmd/cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ACP } from "../agent"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { withNetworkOptions, resolveNetworkOptions } from "@ericsanchezok/synergy-cli/cli/network"

const log = Log.create({ service: "acp-command" })

export const AcpCommand = cmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) => {
    return withNetworkOptions(yargs).option("cwd", {
      describe: "working directory",
      type: "string",
      default: process.cwd(),
    })
  },
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args, { output: "silent" })
    const server = Server.listen(opts)

    const sdk = createSynergyClient({
      baseUrl: `http://${server.hostname}:${server.port}`,
      directory: args.cwd,
    })

    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          process.stdout.write(chunk, (err) => {
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          })
        })
      },
    })
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk))
        })
        process.stdin.on("end", () => controller.close())
        process.stdin.on("error", (err) => controller.error(err))
      },
    })

    const stream = ndJsonStream(input, output)
    const agent = await ACP.init({ sdk })

    new AgentSideConnection((conn) => {
      return agent.create(conn, { sdk })
    }, stream)

    log.info("setup connection")
    process.stdin.resume()
    await new Promise((resolve, reject) => {
      process.stdin.on("end", resolve)
      process.stdin.on("error", reject)
    })
  },
})
