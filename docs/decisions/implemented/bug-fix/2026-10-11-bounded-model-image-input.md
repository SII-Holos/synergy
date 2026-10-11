# Decision Record: Bound model image input while retaining original attachments

Status: implemented

## Problem

Eligible image Assets were expanded into provider requests without decoding or a shared size budget. Large contact sheets and damaged pixel data could cause the provider to reject the whole conversation, even when local previews and file-header checks succeeded. Per-tool fixes would leave uploads, inline inputs and other tool results inconsistent.

## Decision

`AgentTurn` prepares all local image representations before recording and Worker dispatch. Harness owns the policy and a Runtime-scoped image processor registration. Local Runtime provides a lazily loaded Sharp decoder alongside its other native host capabilities, so the core CLI and complete product share the behavior without importing optional Media features into Harness or eagerly loading a codec in Workers.

Each transient image fits a 2048-pixel longest edge, 2500 patches of 32×32 pixels and 4 MiB of encoded bytes. Scaling preserves aspect ratio without enlargement. Encoded input is bounded at 64 MiB and decoding at 100 million pixels; native pipelines have a ten-second processing timeout. Images are decoded before transport, EXIF rotation is applied, and the actual format determines the transmitted MIME type. Small valid PNG/JPEG/WebP images retain their encoded bytes when safe; resized PNG and other supported raster inputs become 8-bit PNG, and resized JPEG uses quality 85. No persistent derivative or migration is needed: original Assets, message Parts, filenames and presentation retain their existing identity and bytes.

Decode, conversion and budget failures replace the affected image with a model-visible explanation. Healthy images, text, tool result identities and non-image media remain available. Missing or invalid Asset references, storage integrity failures, cancellation and recording errors retain their existing semantics. Remote HTTP(S) references in image/file parts retain provider transport; tool-result media requires base64 under the AI SDK contract, so a URL in its data becomes an explicit invalid-image omission. Non-base64 data URLs and filesystem path strings also produce omissions. This change adds no network fetch or arbitrary filesystem read. Resized images include source and transmitted dimensions for interpreting coordinates.

The processor serializes native decoding per Runtime and caches at most 32 prepared results within a 64 MiB string-memory budget. The cache is transient, keyed by source bytes, and never stores cancelled work. Embedded hosts may register their own processor; an absent processor produces an explicit image-unavailable explanation.

Provenance: Codex's centralized image preparation and high-detail budget, pinned to [image preparation](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/image_preparation.rs) and [image utilities](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/utils/image/src/lib.rs). Local adaptation: independently implemented against AI SDK messages and Synergy's immutable Assets, with a single provider-independent budget, an encoded-byte cap and a registered native processor. No upstream implementation code is copied.

## Alternatives considered

**Resize only in `view_image`.** This leaves uploaded, generated, browser and inline images outside the budget and duplicates policy across producers.

**Replace stored attachments with resized files.** This loses source fidelity for previews, downloads, later cropping and inspection evidence.

**Let the provider validate every original.** A single rejected image can terminate an otherwise useful model turn, and provider limits differ.

**Load the codec directly from Harness or an optional Media component.** Harness should not own native image dependencies, while model image input must work in the core Local Runtime composition without the optional Media toolset.

## Consequences

Model vision receives bounded, validated derivatives and can explain local image preparation failures instead of losing the entire turn. Very fine text may require a focused crop of the retained original. Native decoding adds processing work on the first use of each image and a packaged Sharp dependency; bounded caching avoids repeating it across turns. Tests cover the original large 16-bit image dimensions, encoded-byte pressure, format and orientation handling, per-image degradation, immutable storage, cancellation, Runtime isolation and actual provider requests through a Worker.
