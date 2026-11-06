# Media

Document extraction, speech, audio and image processing capabilities.

Load heavy parsers and media workers through the owning feature. Register document text extraction explicitly and preserve processing errors and cancellation.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `presets/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/media` from the repository root; `bun script/pack-workspace.ts packages/media .artifacts/packages` builds its workspace dependency closure.

Speech configuration belongs to the media-owned `voice` domain. An optional `enabled` switch disables a capability without deleting its model; an omitted switch preserves model-based enablement. Nullable endpoint, recognition language, voice, instructions and API key values persist explicit clears. The owner normalizes those clears to runtime defaults and redacts/restores credentials through configuration extension hooks.

`POST /voice/preview` (`voice.preview`) accepts a nonempty, trimmed sample of at most 200 characters, uses saved TTS configuration and returns WAV or MP3 bytes with the matching MIME type. It uses the canonical voice call recorder without creating a session or message. Transcription and preview propagate the request abort signal and retain structured domain failure reasons.
