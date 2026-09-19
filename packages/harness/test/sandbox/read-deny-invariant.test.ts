import { describe, expect, test } from "bun:test"
import * as os from "node:os"
import * as path from "node:path"
import { buildPermissionProfile } from "../../src/sandbox/policy-engine"
import { CREDENTIAL_PATHS, READ_DENY_PATHS, readDenyPathsFor } from "../../src/sandbox/policy"

// ---------------------------------------------------------------------------
// sandbox/read-deny-invariant.test.ts
//
// The deny list is the security-relevant surface of the deny-list read model:
// reads are allowed globally, so a credential location missing from the deny
// set is readable by default. The set must therefore survive every workspace
// shape an operator can configure, including a Scope directory that resolves
// to the home directory or to a directory inside it.
//
// The measured regression this file pins: pruning every deny equal to or
// inside a writable root collapsed the set to zero for `workspace == $HOME`
// and for `$HOME ∈ writableRoots`, leaving `~/.ssh`, `~/.aws`,
// `~/.synergy/data/auth`, and `~/.netrc` globally readable — with no
// `--tmpfs /` fallback left on Linux to hide them.
//
// Run with:
//   cd packages/harness && bun test test/sandbox/read-deny-invariant.test.ts
// ---------------------------------------------------------------------------

const home = os.homedir()

// Tool-compatibility read exemptions, recorded as an operator decision:
// kubectl and docker load their config stores at startup with no
// credential-injection fallback, so denying them breaks the tool outright.
const READ_EXEMPT_CREDENTIALS = [path.join(home, ".kube"), path.join(home, ".docker", "config.json")]

/**
 * The four measured configurations, expressed through the profile builder —
 * the path an operator's Scope directory actually takes.
 */
const CONFIGURATIONS = [
  { name: "ordinary workspace", workspace: path.join(home, "proj", "demo"), approvedWritePaths: [] as string[] },
  { name: "workspace == $HOME", workspace: home, approvedWritePaths: [] as string[] },
  {
    name: "$HOME in writableRoots",
    workspace: path.join(home, "proj", "demo"),
    approvedWritePaths: [home],
  },
  { name: "workspace == $HOME/.synergy", workspace: path.join(home, ".synergy"), approvedWritePaths: [] as string[] },
]

function readDeniesFor(configuration: (typeof CONFIGURATIONS)[number]): string[] {
  return (
    buildPermissionProfile({
      workspace: configuration.workspace,
      executionCwd: configuration.workspace,
      sandboxMode: "workspace_write",
      approvedReadPaths: [],
      approvedWritePaths: configuration.approvedWritePaths,
      approvedNetwork: false,
      approvedUnixSockets: [],
    }).fileSystem.readDenyPaths ?? []
  )
}

describe("read deny list never collapses", () => {
  for (const configuration of CONFIGURATIONS) {
    test(`${configuration.name} keeps every credential deny`, () => {
      const denies = readDeniesFor(configuration)

      // A zero-length deny set means the global read allow is unqualified:
      // every credential store on the host becomes readable. This is the
      // exact failure the measured configurations above produced.
      expect(denies.length).toBeGreaterThan(0)

      for (const credential of CREDENTIAL_PATHS(home)) {
        if (READ_EXEMPT_CREDENTIALS.includes(credential)) continue
        // The one legitimate carve-out: a Scope directory rooted exactly at a
        // credential path cannot deny itself or the project is unusable.
        if (credential === configuration.workspace) continue
        expect({ configuration: configuration.name, credential, denied: denies.includes(credential) }).toEqual({
          configuration: configuration.name,
          credential,
          denied: true,
        })
      }
    })
  }

  test("a writable root is never grounds to drop a credential deny", () => {
    const withoutHome = readDeniesFor(CONFIGURATIONS[0]!)
    const withHome = readDeniesFor(CONFIGURATIONS[2]!)

    // Adding a writable root may only ever keep or add denies. Dropping one is
    // what turned the home directory into a readable credential store.
    for (const deny of withoutHome) expect(withHome).toContain(deny)
    expect(withHome).toContain(path.join(home, ".ssh"))
    expect(withHome).toContain(path.join(home, ".netrc"))
  })

  test("keeps credential denies strictly inside the workspace", () => {
    // A deny inside the workspace used to be pruned as "shadowed by the deeper
    // writable bind". The mount order guarantees it is not shadowed, so it is
    // kept and enforced; this pins the entry rather than the mechanism.
    const denies = readDeniesFor(CONFIGURATIONS[1]!)
    expect(denies).toContain(path.join(home, ".ssh"))
    expect(denies).toContain(path.join(home, ".synergy", "data", "auth"))
    expect(denies).toContain(path.join(home, ".netrc"))
  })

  test("drops only a deny equal to the workspace itself", () => {
    const workspace = path.join(home, ".ssh")
    const denies = readDenyPathsFor({ workspace })
    expect(denies).not.toContain(workspace)
    expect(denies).toContain(path.join(home, ".aws"))
    expect(denies).toContain(path.join(home, ".gnupg"))
  })

  test("drops only a workspace-equal deny, never an unrelated credential", () => {
    const denies = readDenyPathsFor({ workspace: home })
    expect(denies).toContain(path.join(home, ".ssh"))
    expect(denies).not.toContain(home)
  })
})

describe("deny list covers Linux reachable stores", () => {
  test("denies Linux credential spellings hidden only by the old tmpfs root", () => {
    const denies = READ_DENY_PATHS(home)
    for (const linuxStore of [
      ".zsh_history",
      ".bash_history",
      path.join(".config", "google-chrome"),
      path.join(".config", "chromium"),
      path.join(".config", "BraveSoftware"),
      path.join(".config", "vivaldi"),
      ".thunderbird",
      path.join(".local", "share", "keyrings"),
      ".password-store",
      path.join(".config", "rclone", "rclone.conf"),
      path.join(".terraform.d", "credentials.tfrc.json"),
      ".my.cnf",
      ".pgpass",
      path.join(".config", "wrangler"),
    ]) {
      expect({ linuxStore, denied: denies.includes(path.join(home, linuxStore)) }).toEqual({
        linuxStore,
        denied: true,
      })
    }
  })

  test("denies Synergy runtime secret stores reachable under the full-read root", () => {
    const denies = READ_DENY_PATHS(home)
    for (const store of [
      path.join(".synergy", "data", "browser", "profiles"),
      path.join(".synergy", "cache", "inspire-token.json"),
      path.join(".synergy", "data", "library.db"),
      path.join(".synergy", "log"),
      path.join(".synergy", "state"),
      path.join(".synergy", "config", "skills"),
    ]) {
      expect({ store, denied: denies.includes(path.join(home, store)) }).toEqual({ store, denied: true })
    }
  })

  test("the runtime cache staging root stays readable", () => {
    // Stage 2 of the Linux helper re-reads the staged permission profile and
    // re-execs the staged helper binary from this directory. Denying it would
    // break sandboxed execution outright, so only the token file inside it is
    // denied.
    const denies = READ_DENY_PATHS(home)
    expect(denies).not.toContain(path.join(home, ".synergy", "cache"))
    expect(denies).not.toContain(path.join(home, ".synergy", "cache", "synergy-sandbox"))
  })
})
