import type { Auth, Provider } from "@ericsanchezok/synergy-sdk"

export type AuthImportResult =
  | ({ type: "success"; provider?: string } & ({ refresh: string; access: string; expires: number } | { key: string }))
  | { type: "failed"; message?: string }

export type AuthOuathResult = { url: string; instructions: string } & (
  | {
      method: "auto"
      callback(): Promise<
        | ({ type: "success"; provider?: string } & (
            | { refresh: string; access: string; expires: number }
            | { key: string }
          ))
        | { type: "failed" }
      >
    }
  | {
      method: "code"
      callback(
        code: string,
      ): Promise<
        | ({ type: "success"; provider?: string } & (
            | { refresh: string; access: string; expires: number }
            | { key: string }
          ))
        | { type: "failed" }
      >
    }
)

export type AuthPrompt =
  | {
      type: "text"
      key: string
      message: string
      placeholder?: string
      validate?: (value: string) => string | undefined
      condition?: (inputs: Record<string, string>) => boolean
    }
  | {
      type: "select"
      key: string
      message: string
      options: Array<{ label: string; value: string; hint?: string }>
      condition?: (inputs: Record<string, string>) => boolean
    }

export type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, unknown>>
  methods: Array<
    | {
        type: "oauth"
        label: string
        prompts?: AuthPrompt[]
        authorize(inputs?: Record<string, string>): Promise<AuthOuathResult>
      }
    | {
        type: "api"
        label: string
        prompts?: AuthPrompt[]
        authorize?(
          inputs?: Record<string, string>,
        ): Promise<{ type: "success"; key: string; provider?: string } | { type: "failed" }>
      }
    | {
        type: "import"
        label: string
        prompts?: AuthPrompt[]
        import(inputs?: Record<string, string>): Promise<AuthImportResult>
      }
  >
}
