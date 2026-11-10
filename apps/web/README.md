![Logo](https://s3.devantage.com.br/devantage-public/logo-100x100.png)

# DocScanify Web

A document scanner that runs entirely in the browser. Take photos or upload images of one or more documents, check the detected edges, adjust each page and export everything as PDF, PNG or JPG.

The images never leave the device: detection, cropping, filters and export all run in the page, powered by [DocScanify](../../libs/core/README.md). After the first visit the app also works offline, and it can be installed on phones and computers.

![The app scanning an invoice photographed on a desk: upload, automatic edge detection, a corner dragged and detected again, black and white filter and PDF export](docs/demo.gif)

_The photo used above is in [`docs/sample-invoice.jpg`](docs/sample-invoice.jpg), if you want to try it yourself._

[Features](#features)  
[Installation](#installation)  
[Development](#development)  
[Build and run](#build-and-run)  
[Extending the app](#extending-the-app)  
[Architecture](#architecture)  
[How it works](#how-it-works)  
[License](#license)

## Features

The app guides the user through four steps, shown in the top bar.

### 1. Upload

- **Photos or files.** Upload images (several at once, or dropped on the page) or take photos in sequence with the camera. Any image the browser can read works.
- **Automatic detection.** Each image goes through edge detection as soon as it arrives, with a progress bar.
- **Several documents per scan.** The documents appear in a carousel, where they can be added, removed and reordered. The order of the carousel is the order of the export: the pages of a single PDF, or the numbering of the files in a ZIP.
- **Reordering everywhere.** Drag with the mouse, hold and drag on touch screens, or use <kbd>Alt</kbd> + <kbd>←</kbd> / <kbd>→</kbd> on the keyboard. A compact version of the carousel stays below the preview in every step.

### 2. Crop

- **Draggable corners.** The detected corners show up as crop marks that can be dragged with the mouse or a finger, with a magnifying loupe while dragging.
- **Detect again.** "Detect automatically" (<kbd>Ctrl</kbd> / <kbd>Cmd</kbd> + <kbd>Z</kbd>) puts the corners back on the edges of the document, or on the corners of the image when no document is found.
- **Safe to continue.** Crossed corners on any document block the next step, and the document is marked with "!" in the carousel.

### 3. Adjust

- **Perspective corrected.** The preview shows the document cropped and straightened.
- **Per-document adjustments.** Color, grayscale or black and white filter, rotation and sharpness (soft or strong). Sharpening also reduces the noise first, so it does not sharpen the grain of the photo.
- **Apply to all.** Copies the color and sharpness settings to every other document.

### 4. Export

- **PDF**, with A4, Letter or document-sized pages and margins in centimeters. Several documents become a single PDF with one page each, or one PDF per document in a ZIP.
- **PNG or JPG**, one file per document, in a ZIP when there is more than one.
- **Generated in the browser** and downloaded right away.

### Everywhere

- **Private.** Nothing is uploaded to a server.
- **Works offline and installs as an app** (PWA), with a notice when a new version is available.
- **Brazilian Portuguese**, fixed: the app ignores the browser languages and has no language picker. English and Spanish are still translated and come back by turning off `FIXED_LOCALE` (see below).

## Installation

The app lives in the DocScanify monorepo, an [Nx](https://nx.dev) workspace. Every command runs from the root of the repository.

Requirements: Node.js 20 or later and npm.

```bash
git clone https://github.com/devantage/docscanify.git
cd docscanify
npm install
```

`npm install` also copies `opencv.js`, which the edge detection needs, from `node_modules` to `apps/web/public/`. If that file is ever missing, run `npm run postinstall` again.

## Development

```bash
npx nx dev web          # dev server on http://localhost:5173, with hot reload
```

The app imports the library from its source code in `libs/core`, so changes to the library show up in the app right away, without building it.

The camera (`getUserMedia`) only works on HTTPS or `localhost`. To test it on a phone over the local network, use an HTTPS tunnel (ngrok, Cloudflare Tunnel) or serve Vite with a certificate. Without HTTPS, "Take photo" opens the native camera of the phone through the file picker instead.

| Command                | Description                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `npx nx dev web`       | Dev server with hot reload. It has no service worker                                    |
| `npx nx typecheck web` | Type checks the app, without emitting files                                             |
| `npx nx lint web`      | ESLint (the Nx React rules plus the monorepo rules), fixing what it can                 |
| `npm run format`       | Prettier on the files changed since `main` (`npx nx format:write --all` for every file) |

Code and comments are in English, and the texts of the interface live in `src/i18n/locales/`. The pre-commit hook lints the staged files.

## Build and run

```bash
npx nx build web        # builds the app into dist/apps/web/
npx nx preview web      # builds, then serves the build on http://localhost:4173
```

The build is a static site: `dist/apps/web/` can be served by any static host (Nginx, S3, GitHub Pages, Netlify and so on). A few things to keep in mind:

- **HTTPS** is required for the camera, the service worker and installing the app.
- **Sub-paths.** To serve the app under a path such as `/scanner/`, set Vite's [`base`](https://vite.dev/config/shared-options.html#base) in `vite.config.ts`. The manifests and the OpenCV URL already follow it.
- **Caching.** The service worker keeps every file of the build (about 10 MB, mostly `opencv.js`), so later visits open instantly and offline. Serve `sw.js` without long cache headers, so new versions are found.

To test the offline mode, open the preview, then turn the network off in the DevTools (Application → Service workers → Offline) and reload.

### Docker

The [`Dockerfile`](Dockerfile) builds the app and serves it with nginx, as a non-root user, on port 8080. Build it from the root of the monorepo, because the build needs the library and the workspace:

```bash
docker build . -f apps/web/Dockerfile -t docscanify-web
docker run -p 8080:8080 docscanify-web   # http://localhost:8080
```

The site configuration, in [`nginx.conf`](nginx.conf), compresses the files, caches the hashed assets for a year and makes the browser check `index.html`, `sw.js`, the manifests and `opencv.js` on every visit, so new versions are found. Put the container behind a proxy with HTTPS in production.

Images for `linux/amd64` and `linux/arm64` are published to the GitHub Container Registry as `ghcr.io/devantage/docscanify/web` by pushing a tag `web-v<version>`, where the version is the one in [`package.json`](package.json). The image gets three tags: the version, `stable` and `latest`.

## Extending the app

The app is built to be extended: the scanning engine is made of replaceable parts, each feature lives in its own folder, and the generic components and hooks know nothing about scanning.

### Replacing parts of the scanning engine

DocScanify works through [adapters](../../libs/core/README.md#adapters): the decoder, the resizer, the corners detector, the cropper and the encoders are all interfaces. The app creates its adapters once, in `src/lib/scan.ts`, so replacing one there changes it for the whole app. For example, to detect the corners with your own model:

```ts
// src/lib/scan.ts
const adapters: ScannedDocumentAdapters = {
  ...createDefaultAdapters({ scriptUrl }),
  cornersDetector: new MyCornersDetector(),
};
```

### Adding a filter or an enhancement

A filter is anything that implements the `ImageFilter` port of DocScanify: it receives the document as PNG and returns it filtered. To offer a new one, for example `sepia`:

1. Add it to the `Filter` type in `src/lib/types.ts`.
2. Create it in `createFilter`, in `src/lib/scan.ts`.
3. Add it to `FILTERS` in `src/features/result/EnhanceOptionsForm.tsx`.
4. Add the `enhance.filter.sepia` label to every file in `src/i18n/locales/`.

Enhancements (`ImageEnhancer`) work the same way, through `createEnhancers`. The adjustments are part of the cache key of the renders, so the previews, the thumbnails and the export pick them up with no other change.

### Adding a language

1. Create `src/i18n/locales/<code>.json` with the same keys as `pt-BR.json`.
2. Register it in `MESSAGES` and `LOCALES`, in `src/i18n/config.ts`.
3. If its country has no flag yet, draw it in `FLAGS`, in `src/components/Flag.tsx`.

The keys are typed from `pt-BR.json`, so a missing key fails to compile. The new language also gets its own web app manifest, built from its `app.description`, with no other change.

In components, texts come from `useTranslate()`:

```tsx
const { t } = useTranslate();

t('upload.emptyTitle');
t('upload.filledTitle', { count }); // plural: { "one": "…", "other": "…" } in the JSON
```

### Reusing the building blocks

- **Generic components** in `src/components/` (`ProgressBar`, `Segmented`, `Spinner`, layout, icons) receive everything through props.
- **Generic hooks** in `src/hooks/`: drag-and-drop reordering with mouse, touch and keyboard (`useSortable`), file drop areas (`useFileDrop`), image picking (`useImagePicker`) and keyboard shortcuts (`useCommandShortcut`).
- **Notices:** `useToast()` shows success, info, warning and error toasts from any component, with an optional action button. Toasts about an ongoing condition take an `id`, so showing them again replaces them, and `dismiss(id)` removes them.

## Architecture

The code is organized by feature. Each component imports its own CSS, global styles live in `src/styles/`, and imports use the `@/` alias for `src/`.

```text
src/
  main.tsx            Entry point: global styles, language and notices
  app/                Composition: providers, top bar and the current step
  features/           One folder per feature
    steps/            Current step and navigation (useSteps)
    scan/             The scan session shared by every step: documents, import, thumbnails, export options (useScan)
    documents/        Document list: carousel, import, detection, previews and the render cache
    upload/           Upload step
    crop/             Crop step: corner editor, loupe and alerts
    result/           Adjust and Export steps: preview, options and export
    camera/           Camera, opened over any step (useCamera)
    pwa/              Service worker registration and the new version notice
  i18n/               Languages, locale detection and t()
  components/         Generic components, only through props
  hooks/              Generic hooks, with no business rules
  lib/                Plain functions, no React: DocScanify setup, detection, export, images
  styles/             Tokens, base, layout and controls
plugins/
  webManifest.ts      Vite plugin: one web app manifest per language, and the language metadata of index.html
scripts/
  copy-opencv.mjs     Copies opencv.js to public/ on install
```

The steps and the carousel of the session read the contexts (`useSteps`, `useScan`, `useCamera`). Every other component receives what it needs through props, so it can be reused.

## How it works

- **On-device processing.** An image goes straight to `ScannedDocument.fromImage`, which decodes it, limits it to 3000 px on the longest side and keeps the corners in the coordinates of the original image. Only camera frames, which are not files, are turned into PNG first.
- **OpenCV on demand.** OpenCV.js has about 9 MB, so it stays out of the bundle. It is loaded from `opencv.js` on the first detection.
- **Rendered once.** Each render (the document cropped and adjusted) is cached as PNG, keyed by the document, its corners and its adjustments. The preview, the thumbnails and the export all go through this cache, so moving between documents and steps does not render again; only a new crop or adjustment does.
- **Export.** Each document is encoded by DocScanify. Single PDFs are merged with [pdf-lib](https://pdf-lib.js.org/), and ZIP files are made with [fflate](https://github.com/101arrowz/fflate).
- **Languages.** With `FIXED_LOCALE` on in `src/i18n/locale.ts` (the default), the app always uses `DEFAULT_LOCALE` (`pt-BR`) and the top bar has no language picker. With it off, the first language is the one picked before in the top bar, then the first browser language the app supports (regional variants fall back to the closest one, such as `pt-PT` → `pt-BR`), then `DEFAULT_LOCALE` from `src/i18n/locale.ts`. The `lang`, the description and the manifest of the page follow the language. Before the app starts, which is also what crawlers and link previews read, they are the ones of `DEFAULT_LOCALE`, added to `index.html` by `plugins/webManifest.ts` from the messages of that language. Changing `DEFAULT_LOCALE` is enough to change them.
- **Installable.** Each language has its own web app manifest, so the installed app shows its description in the user's language. They all share the same `id`, so switching languages does not create another app.
- **Offline and updates.** A service worker from [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) keeps every file of the build after the first visit. A new version is downloaded in the background and announced with an **Update** button. The app never reloads by itself, because the documents being edited only exist in the page memory: closing the notice keeps the current version until the app is opened again. An app left open checks for new versions every hour.

## License

This app is licensed under [MIT](../../LICENSE.md) terms.
