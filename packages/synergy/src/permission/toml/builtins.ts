import type { PermissionProfileToml } from "./types"

const builtins: Record<string, PermissionProfileToml> = {
  ":read-only": {
    description: "Read-only access to the workspace. No write, no network access.",
    filesystem: {
      read: [":workspace"],
    },
    network: {
      enabled: false,
    },
  },
  ":workspace": {
    description: "Read and write access to the workspace. No network access.",
    filesystem: {
      read: [":workspace"],
      write: [":workspace"],
    },
    network: {
      enabled: false,
    },
  },
  ":danger-full-access": {
    description: "Full read/write filesystem access and network access.",
    filesystem: {
      read: [":root"],
      write: [":root"],
    },
    network: {
      enabled: true,
    },
  },
}

export namespace TomlBuiltins {
  export function get(name: string): PermissionProfileToml | undefined {
    return builtins[name]
  }
}
