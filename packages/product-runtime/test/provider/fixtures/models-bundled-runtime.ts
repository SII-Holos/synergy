import { ModelsCatalog } from "@ericsanchezok/synergy-harness/provider/models"

if (ModelsCatalog.Provider.safeParse({}).success || ModelsCatalog.Model.safeParse({}).success) {
  throw new Error("Invalid model records must be rejected")
}

const catalog = await ModelsCatalog.get()
process.stdout.write(JSON.stringify({ providers: Object.keys(catalog) }))
