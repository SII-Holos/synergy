import path from "node:path"
import { z } from "zod"
import { openAgentRuntime } from "@ericsanchezok/synergy-agent-runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime/host"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { readMemberHome, type MemberHome, type MemberIdentity } from "./home"
import { readMemberRegistration } from "./enrollment"
import { MemberHomeError } from "./record"
import { registerMemberSources } from "./sources"
import { metadata } from "./worker"

const MemberListener = z.strictObject({
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
})

function memberEnvironment(member: MemberHome, input: Readonly<Record<string, string | undefined>>) {
  const selected: Record<string, string> = {}
  for (const key of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
  ])
    if (input[key] !== undefined) selected[key] = input[key]
  return {
    ...selected,
    HOME: member.home,
    USERPROFILE: member.home,
    XDG_CONFIG_HOME: path.join(member.home, ".config"),
    XDG_CACHE_HOME: path.join(member.home, ".cache"),
    XDG_DATA_HOME: path.join(member.home, ".local", "share"),
    XDG_STATE_HOME: path.join(member.home, ".local", "state"),
    APPDATA: path.join(member.home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(member.home, "AppData", "Local"),
    SYNERGY_HOME: member.home,
    SYNERGY_RUNTIME_ROOT: member.root,
    SYNERGY_MEMBER_IDENTITY: JSON.stringify(member.identity),
    ...(input.SYNERGY_TEST_HOME ? { SYNERGY_TEST_HOME: member.home } : {}),
  }
}

export async function openMemberRuntime(input: {
  home: string
  identity: MemberIdentity
  environment?: Readonly<Record<string, string | undefined>>
  listen?: z.infer<typeof MemberListener>
  signal?: AbortSignal
}) {
  input.signal?.throwIfAborted()
  const listener = MemberListener.optional().safeParse(input.listen)
  if (!listener.success)
    throw new MemberHomeError("Member Runtime listener requires an explicit port and private credential")
  const member = await readMemberHome(input.home, input.identity)
  const registration = await readMemberRegistration(member.home, member.identity)
  if (!registration || registration.state !== "active")
    throw new MemberHomeError("Member Runtime must be enrolled before startup")
  const components = [
    localRuntime({ workers: false, environment: false }),
    ...(listener.data ? [(await import("@ericsanchezok/synergy-server/component")).server()] : []),
    {
      ...metadata,
      features: { kind: "foundation" as const, definitions: [] },
      requires: { "local-runtime": metadata.version },
      workers: { agent: new URL("./worker.ts", import.meta.url), policy: new URL("./worker.ts", import.meta.url) },
      register: () => registerMemberSources(member.identity),
    },
  ]
  return openAgentRuntime({
    home: member.root,
    host: createLocalHost({
      home: member.home,
      root: member.root,
      env: {
        ...memberEnvironment(member, input.environment ?? process.env),
        ...(listener.data ? { SYNERGY_SERVER_TOKEN: listener.data.token } : {}),
      },
    }),
    components,
    features: FeatureSelection.resolve(components),
    mode: listener.data ? "server" : "oneshot",
    listen: !!listener.data,
    network: listener.data ? { hostname: "127.0.0.1", port: listener.data.port } : undefined,
    signal: input.signal,
  })
}
