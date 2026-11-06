import defaults from "./vendor/moby-seccomp.json"

// Docker's default profile blocks nested namespaces. Preserve its remaining syscall policy while allowing
// bubblewrap to create namespaces as UID 1000; the container retains no SYS_ADMIN capability.
// Derived from Moby profiles 85e237f1fe229a0c61c9c7d8e743fa780d3b97ca (Apache-2.0):
// https://github.com/moby/profiles/blob/85e237f1fe229a0c61c9c7d8e743fa780d3b97ca/seccomp/default.json
export function executionSeccomp() {
  const namespaces = new Set(["clone", "clone3", "unshare", "setns", "mount", "umount2", "pivot_root"])
  return {
    ...defaults,
    syscalls: [
      ...defaults.syscalls
        .map((rule) => ({ ...rule, names: rule.names.filter((name) => !namespaces.has(name)) }))
        .filter((rule) => rule.names.length > 0),
      { names: [...namespaces], action: "SCMP_ACT_ALLOW" },
    ],
  }
}
