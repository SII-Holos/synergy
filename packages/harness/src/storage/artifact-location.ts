import { z } from "zod"

export const MAX_COMPRESSED_ARTIFACT_BYTES = 32 * 1024 * 1024

export const ArtifactLocation = z
  .object({
    pack: z.string().regex(/^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.pack$/),
    blockOffset: z.number().int().nonnegative().safe(),
    blockBytes: z.number().int().nonnegative().safe(),
    decodedBytes: z.number().int().nonnegative().safe(),
    offset: z.number().int().nonnegative().safe(),
    size: z.number().int().nonnegative().safe(),
    codec: z.enum(["raw", "gzip"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine(
    (value) =>
      Number.isSafeInteger(value.blockOffset + value.blockBytes) &&
      Number.isSafeInteger(value.offset + value.size) &&
      value.offset + value.size <= value.decodedBytes &&
      (value.codec === "raw"
        ? value.blockBytes === value.decodedBytes
        : value.blockBytes <= MAX_COMPRESSED_ARTIFACT_BYTES && value.decodedBytes <= MAX_COMPRESSED_ARTIFACT_BYTES),
    "Artifact byte bounds are invalid",
  )
export type ArtifactLocation = z.infer<typeof ArtifactLocation>
