import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ModelsCatalog } from "@ericsanchezok/synergy-harness/provider/models"

if (ModelsCatalog.Provider.safeParse({}).success || ModelsCatalog.Model.safeParse({}).success) {
  throw new Error("Invalid model records must be rejected")
}

await RuntimeContext.create({
  home: process.env.SYNERGY_HOME!,
  root: process.env.SYNERGY_HOME! + "/.synergy",
  env: process.env,
}).run(async () => {
  const catalog = await ModelsCatalog.get()
  process.stdout.write(JSON.stringify({ providers: Object.keys(catalog) }))
})
