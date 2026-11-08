import path from "node:path"
import type { MemberHome } from "./home.js"
import { installedWorkerCommand, installedWorkerEnvironment } from "@ericsanchezok/synergy-util/installed-launcher"
import { MemberHomeError } from "./record.js"

export function memberEnvironment(
  member: MemberHome,
  input: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
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
  if (
    input.SYNERGY_INSTALLATION_PIN &&
    input.SYNERGY_INSTALLATION_ROOT &&
    path.resolve(input.SYNERGY_INSTALLATION_ROOT) === member.root
  ) {
    try {
      installedWorkerCommand(input, "__agent-turn-runner")
      Object.assign(selected, installedWorkerEnvironment(input))
    } catch {
      throw new MemberHomeError("Member Runtime installation identity is invalid")
    }
  }
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
