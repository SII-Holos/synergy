import { ModelsDev } from "../../../src/provider/models"

const catalog = await ModelsDev.get()
process.stdout.write(JSON.stringify({ providers: Object.keys(catalog) }))
