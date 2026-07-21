# Mrky Extension Project Map

## Core Components
- **Background (`src/background/`)**: Service worker managing state, DB interactions (Dexie), Firebase, API routing, and dictionary logic.
- **Content (`src/content/`)**: Scripts injected into web pages.
  - `page-text-observer.js`: Injects interactivity into static text.
    - *Note*: Uses an expanded `querySelectorAll` (including `div`, `span`, etc.) with a surgical filter that skips massive containers (`el.children.length > 5`) to ensure exhaustive text parsing without freezing the UI.
  - `subtitle-overlay.js` / `youtube-observer.js`: Handles video subtitles and streaming.
  - `ocr-handler.js`: Handles image and screen OCR interactions.
  - `tooltip.js`: The floating dictionary UI.
- **Shared (`src/shared/`)**: NLP, API fetchers, database models.
  - `nlp-processor.js`: Uses `compromise` to tag and categorize text. Contains `STOP_WORDS` definition.
- **Popup/Offscreen**: Extension UI and audio playback processing.

## Current State & Resolved Items
- ~~NLP Processor marks `STOP_WORDS` as `isStop = true`~~ — **Resolved**: `isStop` is now
  hard-coded to `false` in `nlp-processor.js` (disabled per user request). All common English
  words are interactive. The `isStop` property still flows through the pipeline but is always
  falsy; downstream checks in `page-text-observer.js`, `overlay-renderer.js`, and
  `ocr-handler.js` are effectively no-ops and can be removed in a future cleanup pass.

## Known Limitations
- `host_permissions: <all_urls>` is required for the tool to work on arbitrary pages, but
  broadens the attack surface. Document justification for Chrome Web Store review.
- No automated test suite — manual QA only.
