const argv = process.argv.slice(2)
const entry = "/opt/synergy/source/packages/synergy/src/index.ts"

if (argv[0] === "send") {
  await import("synergy/product-registration")
  const { withScopeContext } = await import("synergy/cli/scope")
  const { runMigrations } = await import("synergy/migration/index")
  const { Session } = await import("synergy/session/index")
  await withScopeContext(process.env.SYNERGY_CWD || process.cwd(), async () => {
    await runMigrations({ output: "silent" })
    const session = await Session.create({
      interaction: { mode: "unattended", source: "benchmark" },
      controlProfile: "full_access",
    })
    await Bun.write(
      "/logs/agent/unattended.json",
      JSON.stringify({
        session_id: session.id,
        interaction: session.interaction,
      }),
    )
    argv.push("--session", session.id)
  })
}

process.argv = [process.execPath, entry, ...argv]
await import(entry)
