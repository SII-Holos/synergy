import { ModelsDev } from "@ericsanchezok/synergy-harness/provider/models"

const catalog = await ModelsDev.get()
process.stdout.write(JSON.stringify({ providers: Object.keys(catalog) }))
