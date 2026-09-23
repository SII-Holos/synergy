const legacy = await Bun.file("/opt/synergy/source/packages/synergy/package.json").exists()
if (!legacy) process.env.SYNERGY_HOME = "/logs/agent/unattended-fixture-home"
const root = "/opt/synergy/source/packages/"
await import(root + (legacy ? "synergy" : "product-runtime") + "/src/product-registration.ts")
const { withScopeContext } = await import(root + (legacy ? "synergy" : "cli") + "/src/cli/scope.ts")
const { Session } = await import(root + (legacy ? "synergy" : "harness") + "/src/session/index.ts")
const { PermissionNext } = await import(root + (legacy ? "synergy" : "harness") + "/src/permission/next.ts")
const runtime = legacy
  ? undefined
  : await (
      await import(root + "product-runtime/src/server/runtime-handle.ts")
    ).ProductRuntimeHandle.openTask({ mode: "oneshot", migrationOutput: "silent" })
const audit = await Bun.file("/logs/agent/unattended.json").json()
await withScopeContext("/app", async () => {
  const parent = legacy ? await Session.get(audit.session_id) : await Session.create({ interaction: audit.interaction })
  if (parent.interaction?.mode !== "unattended") throw new Error("Interactive parent session")
  const child = await Session.create({ parentID: parent.id })
  const stored = await Session.get(child.id)
  if (stored.interaction?.mode !== "unattended") throw new Error("Interactive child session")
  if (!PermissionNext.disabled(["question"], PermissionNext.sessionRuleset(stored)).has("question")) {
    throw new Error("Child question catalog is interactive")
  }
  await Bun.write(
    "/logs/agent/unattended-child.json",
    JSON.stringify({
      parent: parent.interaction,
      child: stored.interaction,
      question_disabled: true,
      fixture_home: !legacy,
    }),
  )
})
await runtime?.close()
process.exit(0)
