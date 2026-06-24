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
  (sysctl-name "user.*")
  (sysctl-name "machdep.*"))
(allow iokit-open
  (iokit-connection "IOKit")
  (iokit-user-client-class "IOAudioControlUserClient")
  (iokit-user-client-class "IOAudioEngineUserClient")
  (iokit-user-client-class "IOHIDLibUserClient")
  (iokit-user-client-class "IOSurfaceRootUserClient")
  (iokit-user-client-class "RootDomainUserClient"))
(allow mach-lookup
  (global-name "com.apple.distributed_notifications")
  (global-name "com.apple.distributed_notifications.2")
  (global-name "com.apple.FontServer")
  (global-name "com.apple.FontObjectsServer")
  (global-name "com.apple.FontWorker")
  (global-name "com.apple.MallocDiagnostics")
  (global-name "com.apple.PerformanceAnalysis.animationperfd")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.SystemConfiguration.PPPController")
  (global-name "com.apple.audio.SandboxHelper")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (local-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.CoreServices.coreservicesd")
  (global-name "com.apple.coreservices.launchservicesd")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.DiskArbitration.diskarbitrationd")
  (global-name "com.apple.diskimages-helpers")
  (global-name "com.apple.lsd.mapdb")
  (global-name "com.apple.metadata.mds")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.quicklook.ThumbnailsAgent")
  (global-name "com.apple.revisiond")
  (global-name "com.apple.securityd")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.opendirectoryd.membership")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.cmio.VDCAssistant")
  (global-name "com.apple.tccd")
  (global-name "com.apple.corespotlightservice"))
(allow ipc-posix-sem)
(allow ipc-posix-shm
  (ipc-posix-name-prefix "apple.cfprefs.")
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$")
  (ipc-posix-name-regex #"^/tmp/ompt_"))
(allow file-read* file-write*
  (subpath "/dev/ptmx"))
(allow file-read* file-write*
  (regex #"^/dev/ttys[0-9]+"))
(allow file-read* file-write*
  (subpath "/var/tmp")
  (subpath "/dev/shm")
  (regex #"^/tmp/.com.apple.csseed.*")
  (regex #"^/var/tmp/.*\.sem\..*")
  (regex #"^/private/tmp/.com.apple.csseed.*"))
; ── Core OS libraries ──
(allow file-read*
  (subpath "/usr/lib")
  (subpath "/usr/libexec")
  (subpath "/usr/share")
  (subpath "/usr/include")
  (subpath "/usr/standalone"))
; ── System frameworks ──
(allow file-read*
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/System/Library/CoreServices")
  (subpath "/System/Library/Extensions")
  (subpath "/System/Library/LaunchDaemons"))
; ── Library frameworks ──
(allow file-read*
  (subpath "/Library/Frameworks")
  (subpath "/Library/Frameworks/Python.framework")
  (subpath "/Library/Developer/CommandLineTools"))
; ── Xcode ──
(allow file-read*
  (subpath "/Applications/Xcode.app/Contents/Developer"))
; ── Homebrew Apple Silicon ──
(allow file-read*
  (subpath "/opt/homebrew/Cellar")
  (subpath "/opt/homebrew/opt")
  (subpath "/opt/homebrew/lib")
  (subpath "/opt/homebrew/include")
  (subpath "/opt/homebrew/share")
  (subpath "/opt/homebrew/bin"))
; ── Homebrew Intel ──
(allow file-read*
  (subpath "/usr/local/Cellar")
  (subpath "/usr/local/opt")
  (subpath "/usr/local/lib")
  (subpath "/usr/local/include")
  (subpath "/usr/local/share")
  (subpath "/usr/local/bin"))
; ── Python ──
(allow file-read*
  (subpath "/Library/Frameworks/Python.framework")
  (subpath "/usr/local/lib/python")
  (subpath "/opt/homebrew/lib/python")
  (subpath "/opt/homebrew/Cellar/python")
  (subpath "/usr/local/Cellar/python")
  (subpath "/opt/homebrew/Cellar/python@")
  (subpath "/usr/local/Cellar/python@"))
; ── Node.js ──
(allow file-read*
  (subpath "/usr/local/lib/node_modules")
  (subpath "/opt/homebrew/lib/node_modules"))
; ── Ruby ──
(allow file-read*
  (subpath "/System/Library/Frameworks/Ruby.framework")
  (subpath "/usr/local/lib/ruby")
  (subpath "/opt/homebrew/lib/ruby"))
(allow user-preference-read)`

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
    "/usr/local/Cellar",
    "/usr/local/lib/python",
    "/usr/local/lib/node_modules",
    "/usr/local/lib/ruby",
    "/usr/share",
    "/usr/standalone",
    "/usr/include",
    "/System/Library",
    "/System/Library/Frameworks",
    "/System/Library/PrivateFrameworks",
    "/System/Library/CoreServices",
    "/System/Library/Extensions",
    "/Library",
    "/Library/Frameworks",
    "/Library/Frameworks/Python.framework",
    "/Library/Frameworks/Ruby.framework",
    "/Library/Developer/CommandLineTools",
    "/Applications/Xcode.app/Contents/Developer",
    "/opt/homebrew",
    "/opt/homebrew/bin",
    "/opt/homebrew/lib",
    "/opt/homebrew/opt",
    "/opt/homebrew/Cellar",
    "/opt/homebrew/include",
    "/opt/homebrew/share",
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
  // Unix socket policy
  // ------------------------------------------------------------------

  /** SBPL rules to allow Unix domain socket access for each allowed socket path */
  export function unixSocketPolicy(sockets: string[]): string {
    if (sockets.length === 0) return ""
    const lines: string[] = []
    lines.push("(allow system-socket AF_UNIX)")
    for (const socket of sockets) {
      const escaped = socket.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      lines.push(`(allow file-read* file-write* (subpath "${escaped}"))`)
    }
    return lines.join("\n")
  }

  // ------------------------------------------------------------------
  // Parameterized path generation
  // ------------------------------------------------------------------

  /** Generate a Seatbelt parameter name for indexed path variables */
  export const SBPL_PARAM_NAME = (index: number): string => `PATH_READ_${index}`
}
