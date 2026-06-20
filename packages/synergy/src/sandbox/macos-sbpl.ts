// ------------------------------------------------------------------
// macOS Seatbelt Policy Language (SBPL) constants
//
// SBPL building blocks for sandbox-exec profiles implementing a
// (deny default) policy with curated platform allowlists.
//
// Used by macos-policy.ts to construct parameterized Seatbelt profiles.
// ------------------------------------------------------------------

export namespace MacOSSbpl {
  // ------------------------------------------------------------------
  // Base policy
  // ------------------------------------------------------------------

  /** (deny default) base policy — the strictest starting point */
  export const DENY_DEFAULT_BASE = `(version 1)
(deny default)`

  // ------------------------------------------------------------------
  // Platform defaults — essential system access for any process
  // ------------------------------------------------------------------

  /** Essential system access rules required for process viability under (deny default) */
  export const PLATFORM_DEFAULTS = `(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow sysctl-read
  (sysctl-name "kern.*")
  (sysctl-name "hw.*")
  (sysctl-name "vm.*")
  (sysctl-name "vfs.*")
  (sysctl-name "net.*")
  (sysctl-name "debug.*")
  (sysctl-name "security.mac.*")
  (sysctl-name "machdep.*"))
(allow iokit-open
  (iokit-connection "IOKit")
  (iokit-user-client-class "RootDomainUserClient"))
(allow mach-lookup
  (global-name "com.apple.distributed_notifications")
  (global-name "com.apple.FontServer")
  (global-name "com.apple.CoreServices.coreservicesd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.securityd")
  (global-name "com.apple.system.notification_center"))
(allow ipc-posix-sem)
(allow ipc-posix-shm)
(allow file-read* file-write*
  (subpath "/dev/ptmx"))
(allow file-read* file-write*
  (regex #"^/dev/ttys[0-9]+"))
(allow file-read*
  (subpath "/usr/lib")
  (subpath "/System/Library")
  (subpath "/Library")
  (subpath "/Applications/Xcode.app"))`

  // ------------------------------------------------------------------
  // Platform default readable paths
  // ------------------------------------------------------------------

  /** Default readable root paths for macOS platform */
  export const MACOS_PLATFORM_READ_ROOTS: string[] = [
    "/bin",
    "/sbin",
    "/usr/bin",
    "/usr/sbin",
    "/usr/libexec",
    "/usr/local",
    "/usr/local/bin",
    "/usr/local/lib",
    "/usr/local/opt",
    "/usr/share",
    "/usr/standalone",
    "/System/Library",
    "/Library",
    "/opt/homebrew",
    "/opt/homebrew/bin",
    "/opt/homebrew/lib",
    "/opt/homebrew/opt",
    "/var/db/timezone",
    "/private/var/db/timezone",
    "/private/var/run",
    "/private/etc",
    "/dev",
  ]

  // ------------------------------------------------------------------
  // Network policy
  // ------------------------------------------------------------------

  /** Map a network mode to its SBPL fragment */
  export function networkingPolicy(mode: "full" | "restricted" | "proxy_only"): string {
    switch (mode) {
      case "full":
        return `(allow network*)`
      case "restricted":
        return `(allow network-inbound)`
      case "proxy_only":
        return `(allow network-inbound)
(allow network-outbound (remote tcp "127.0.0.1:*"))`
    }
  }

  // ------------------------------------------------------------------
  // Parameterized path generation
  // ------------------------------------------------------------------

  /** Generate a Seatbelt parameter name for indexed path variables */
  export const SBPL_PARAM_NAME = (index: number): string => `PATH_READ_${index}`
}
