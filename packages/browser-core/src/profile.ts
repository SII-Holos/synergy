import { z } from "zod"

export const BrowserProfileIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._-]+$/)
export const BrowserPermissionSchema = z.enum(["inherit", "allow", "ask", "deny"])
export const BrowserOriginPolicySchema = z
  .object({
    access: BrowserPermissionSchema.optional(),
    downloads: BrowserPermissionSchema.optional(),
    uploads: BrowserPermissionSchema.optional(),
  })
  .strict()
export const BrowserProfileSchema = z
  .object({
    id: BrowserProfileIdSchema,
    name: z.string().trim().min(1).max(80),
    kind: z.enum(["persistent", "temporary"]),
    enabled: z.boolean(),
    revision: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    origins: z.record(z.string(), BrowserOriginPolicySchema),
  })
  .strict()
  .meta({ ref: "BrowserProfile" })
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>
export type BrowserOriginPolicy = z.infer<typeof BrowserOriginPolicySchema>
export const BrowserProfileListSchema = z
  .object({
    defaultProfileId: BrowserProfileIdSchema.nullable(),
    profiles: z.array(BrowserProfileSchema),
  })
  .strict()
  .meta({ ref: "BrowserProfileList" })

export const BrowserProfileCreateSchema = z
  .object({
    name: BrowserProfileSchema.shape.name,
    kind: BrowserProfileSchema.shape.kind.optional(),
  })
  .strict()
  .meta({ ref: "BrowserProfileCreate" })

export const BrowserProfileUpdateSchema = z
  .object({
    name: BrowserProfileSchema.shape.name.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .meta({ ref: "BrowserProfileUpdate" })

export function browserOrigin(value: string): string {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Use an HTTP(S) website address without credentials.")
  return url.origin
}
