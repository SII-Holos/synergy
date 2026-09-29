# Decision Record: Native Computer observation admission

Status: implemented

## Problem

A task reference previously permitted coordinate and keyboard dispatch even when the native result supplied no usable screenshot or target evidence. WindowServer capture dimensions alone do not prove that a Stage Manager representation is the logical application's content plane. Repeating both native JSON and rendered AX text also obscures the observation and consumes excessive model context.

## Decision

Desktop issues typed independent AX, image and action availability records and keeps native proof tokens private. Each action consumes the latest task observation, uses a monotonic lifetime, and requires its own route evidence. Coordinate actions additionally require the matching image in the model call that selected the action. Missing proof refuses the action; Full Access remains authorization rather than proof of a valid target.

The pinned Cua 0.30.4 source receives a small macOS patch beside Desktop's native build recipe. It reuses upstream immutable captures and per-process mutation admission, verifies process start time and retained AX window identity, compares logical AX geometry with WindowServer and ScreenCaptureKit content geometry, and revalidates under the existing mutation lease. AX results and semantic actions use logical window identity independently of display transforms, so a Stage Manager thumbnail can invalidate pixels without disabling AX. Semantic selection cannot silently choose a pixel route without image proof. The source, patch, Rust toolchain and built executable are identified in a packaging receipt.

Desktop emits one bounded AX representation, while typed status and diagnostic evidence remain outside model prose. An explicit Desktop user-data directory is configured before the single-instance lock; source development derives one from its isolated Home.

Packaged Desktop imports the official SDK from its physical unpacked package. Unpacking only native file extensions is insufficient because Rust resolves the SDK library from the platform package manifest path.

Image delivery uses generic Harness receipts at the final provider transform and existing rollout transport. The originating model call is captured at tool-call admission; neither Computer nor the UI parses provider request bodies. Attachment metadata distinguishes saved, included, submitted and omitted images. The UI consumes the canonical observation schema and withholds coordinate support without a submitted image receipt. Unknown historical records remain unknown.

The native fixture measures application state independently of the worker response. Model acceptance keeps its random canvas code outside AX and model context and checks the clicked window's counter. Image receipts recognize final SDK binary/base64 file parts and nested tool-result images; wire hashes establish actual submission. The native and model scripts emit machine-readable pass/fail/blocked reports and retain private evidence under ignored artifact directories.

Provenance: [Cua's pinned native implementation](https://github.com/trycua/cua/tree/bf6c76786d938070f4ecf1e44004752f69f518b8/libs/cua-driver). Local adaptation: retain its private worker and action serialization, add the logical-window and image proof guards, and adopt the independent AppKit oracle pattern without importing its agent prompts.

## Alternatives considered

**Only improve screenshot display.** This would retain invalid action admission and would not establish that the model receives the image used for coordinates.

**Reject every observation lacking an image.** This would discard useful accessibility content and semantic actions that have an independently valid target.

**Activate windows or switch Spaces before capture.** This changes the shared desktop and violates the existing background exact-window interaction model.

**Replace Cua with another desktop backend.** Cua already provides snapshot binding, exact-target admission and private-worker lifecycle. Keeping the patch scoped to proof and route admission avoids duplicating that runtime.

## Consequences

Unproven capture representations are explicitly unavailable for pixels. Geometry tolerance admits two logical points plus one output-pixel rounding unit; it does not classify windows by size or image content. Source builds require the pinned Rust toolchain, and changes to upstream private structures require patch compilation and actual native acceptance. Historical tool results without quality records remain unknown; they cannot revive an action token. Release verification must separately establish installed-app permissions, real model image input and application state change.
