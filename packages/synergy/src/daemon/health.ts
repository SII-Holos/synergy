import net from "net"
import { isServerReachable } from "../cli/network"

export namespace DaemonHealth {
  export async function isReachable(url: string) {
    return isServerReachable(url)
  }

  export async function isPortListening(port: number, hostname = "127.0.0.1") {
    return await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: hostname })
      socket.setTimeout(3000)
      socket.once("connect", () => {
        socket.end()
        resolve(true)
      })
      socket.once("timeout", () => {
        socket.destroy()
        resolve(false)
      })
      socket.once("error", () => resolve(false))
    })
  }

  export async function waitForHealthy(url: string, timeoutMs = 20_000, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await isReachable(url)) return true
      await Bun.sleep(intervalMs)
    }
    return false
  }

  export async function waitForPortToStop(port: number, hostname = "127.0.0.1", timeoutMs = 10_000, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!(await isPortListening(port, hostname))) return true
      await Bun.sleep(intervalMs)
    }
    return false
  }
}
