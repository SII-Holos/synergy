import fs from "node:fs/promises"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { version } from "../package.json" with { type: "json" }
import { RuntimeIdentity, readRuntimeHome } from "./home"
import { MemberHomeError } from "./record"
import { registerMemberSources } from "./sources"

export const metadata = { id: "organization-runtime", version, apiVersion: 1 } as const

export async function registerWorker() {
  const raw = RuntimeContext.current().host.env.SYNERGY_MEMBER_IDENTITY
  let identity: RuntimeIdentity
  try {
    identity = RuntimeIdentity.parse(JSON.parse(raw ?? ""))
  } catch {
    throw new MemberHomeError("Member worker identity is missing or invalid")
  }
  const runtime = RuntimeContext.current()
  const home = await readRuntimeHome(runtime.host.home, identity)
  if ((await fs.realpath(home.root)) !== (await fs.realpath(runtime.host.root)))
    throw new MemberHomeError("Member worker Home has another native root")
  registerMemberSources(home.identity, home.restoration)
}
