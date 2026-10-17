import { HolosAuth } from "./auth"
import { HolosRuntime } from "./runtime"

export namespace HolosReadiness {
  export type Reason = "not_logged_in" | "not_connected"

  export type Info = {
    ready: boolean
    reason?: Reason
  }

  export type Snapshot = {
    credential: HolosAuth.StoredCredential | undefined
    status: HolosRuntime.Status
    readiness: Info
  }

  export async function snapshot(): Promise<Snapshot> {
    const [credential, status] = await Promise.all([HolosAuth.getStoredCredential(), HolosRuntime.status()])
    const ready = !!credential && status.status === "connected"
    const reason = !credential ? "not_logged_in" : ready ? undefined : "not_connected"

    return {
      credential,
      status,
      readiness: {
        ready,
        reason,
      },
    }
  }

  export async function get(): Promise<Info> {
    const { readiness } = await snapshot()
    return readiness
  }
}
