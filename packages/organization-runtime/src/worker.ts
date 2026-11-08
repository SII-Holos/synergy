import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { version } from "../package.json" with { type: "json" }
import { MemberIdentity } from "./home"
import { MemberHomeError } from "./record"
import { registerMemberSources } from "./sources"

export const metadata = { id: "organization-runtime", version, apiVersion: 1 } as const

export function registerWorker() {
  const raw = RuntimeContext.current().host.env.SYNERGY_MEMBER_IDENTITY
  let identity: MemberIdentity
  try {
    identity = MemberIdentity.parse(JSON.parse(raw ?? ""))
  } catch {
    throw new MemberHomeError("Member worker identity is missing or invalid")
  }
  registerMemberSources(identity)
}
