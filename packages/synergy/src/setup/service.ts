import { Config } from "../config/config"
import { ConfigSetup } from "../config/setup"

export namespace SetupService {
  function importValidationError(result: ConfigSetup.ValidateResult) {
    return new Error(result.warnings.join(", ") || "Invalid config")
  }

  export async function readCurrentConfig() {
    return ConfigSetup.readCurrentConfig()
  }

  export async function validateImport(config: unknown) {
    return ConfigSetup.validateImport(config)
  }

  export function parseImportedConfig(config: unknown) {
    const parsed = Config.Info.safeParse(config)
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => issue.message).join(", "))
    }
    return parsed.data
  }

  export async function probeImport(config: unknown) {
    const validation = await validateImport(config)
    if (!validation.config) {
      throw importValidationError(validation)
    }
    return ConfigSetup.probeImportedCore(validation.config)
  }

  export async function importConfig(config: unknown) {
    const validation = await validateImport(config)
    if (!validation.valid || !validation.config) {
      throw importValidationError(validation)
    }
    return ConfigSetup.importConfig(validation.config)
  }

  export async function validateCore(config: ConfigSetup.SetupDraft) {
    return ConfigSetup.probeRequiredCore(config)
  }

  export async function finalizeSetup(config: ConfigSetup.SetupDraft) {
    const validation = await validateCore(config)
    if (!validation.valid) {
      throw new Error("Required setup validation failed")
    }
    return ConfigSetup.finalizeConfig(config, validation)
  }
}
