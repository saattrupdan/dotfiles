---
name: electron
description:
  Build, secure, test, package, and ship Electron desktop apps. Use for Electron app
  architecture, main/renderer/preload code, IPC, native integrations, desktop debugging,
  Electron Forge, signing, and updates. For automating an Electron app's UI through
  Chromium/CDP, use the agent-browser skill instead.
last-updated: 2026-10-16
---

# Electron app development

Use this for building desktop apps with Electron, not for driving an existing app's UI.
Follow the existing project's toolchain and supported Electron version. For a new
project, start with the current
[tutorial](https://www.electronjs.org/docs/latest/tutorial/tutorial-prerequisites) and
[Electron Forge](https://www.electronforge.io/). Check version-specific API behavior
against the project's Electron version, not just `/docs/latest/`.

## Start or inspect a project

1. Identify target OSes, architectures, distribution channel, Node/package manager,
   Electron version, build tool, and whether the app loads any remote content. Read
   `package.json`, Forge config, main/preload entry points, and renderer code first.
2. For a new app, run `npx create-electron-app@latest my-app` and pick an appropriate
   first-party Forge template (Vite, webpack, or their TypeScript variants) if needed.
   Run `npm start` and confirm the window loads. In an existing app, keep its build
   system; do not introduce Forge solely to change a feature.
3. Put Electron in `devDependencies`; ensure the package `main` entry points to the
   built main-process file. Keep runtime dependencies required by packaged code in
   `dependencies`; validate the packaged app, not only the development server.
4. Map the trust boundaries before adding features: main process owns OS privileges;
   each window/web view has a renderer for UI; preload provides only the explicit bridge
   the UI needs. A renderer is not a trusted backend.

Sources:
[first app](https://www.electronjs.org/docs/latest/tutorial/tutorial-first-app),
[process model](https://www.electronjs.org/docs/latest/tutorial/process-model),
[Forge getting started](https://www.electronforge.io/).

## Build the app across process boundaries

- Wait for `app.whenReady()` before creating `BrowserWindow`s. Use `loadURL` for a dev
  server or `loadFile` / a registered app protocol for bundled assets. Resolve preload
  paths to absolute paths and make sure build output includes the preload.
- Set window preferences deliberately: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, and `webSecurity: true`. Keep remote pages isolated from
  privileged app UI. A sandboxed preload has limited Node access; bundle preload
  dependencies as needed rather than disabling the sandbox to fix import errors.
- On macOS, normally recreate a window on `activate` if none are open; on other
  platforms, normally quit on `window-all-closed`. Decide explicitly how secondary
  windows, links, and app shutdown should behave.
- Expose individual functions through `contextBridge.exposeInMainWorld` in preload. For
  request/response, wrap `ipcRenderer.invoke` with `ipcMain.handle`; for one-way
  notifications, use `send` / `on` with a scoped subscription and unsubscribe path.
  Never expose `ipcRenderer`, an arbitrary channel dispatcher, or raw event objects to
  the renderer. Avoid synchronous IPC.
- In main, validate the sender frame/origin **and** arguments for each privileged
  handler, authorize the requested operation, and return only serializable data. Design
  channels around actions (`saveDocument`, `openFile`) rather than generic
  filesystem/shell access. Type the bridge explicitly if using TypeScript.
- Use native APIs from main: `dialog`, `Menu`, `Tray`, `Notification`, `shell`,
  `session`, and OS integrations as needed. Prefer platform menu roles and test
  platform-specific UI; only call `shell.openExternal` with validated, allowlisted URLs.
  Avoid blocking the main process with heavy work.

Sources: [preload](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload),
[context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation),
[IPC patterns](https://www.electronjs.org/docs/latest/tutorial/ipc),
[sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox),
[menus](https://www.electronjs.org/docs/latest/tutorial/menus),
[API reference](https://www.electronjs.org/docs/latest/api).

## Security gate for each window and feature

Read the full
[Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
before shipping. In particular:

1. Load only necessary, trusted content over secure transport. Do not grant Node access
   to remote content; keep isolation and sandboxing on, and do not disable `webSecurity`
   or enable insecure/experimental web features to bypass a problem.
2. Apply a restrictive Content Security Policy to every renderer. For packaged local
   assets, prefer a purpose-built custom protocol over `file://` where practical.
   Register scheme privileges before `app.ready`, install the handler for each
   session/partition in use, and restrict URLs to known assets with safe path
   resolution. A custom scheme alone is not a security boundary.
3. Restrict navigation and new windows (`will-navigate` / relevant frame events,
   `setWindowOpenHandler`). Explicitly handle permission requests and checks for remote
   content. Review download handling, external links, and embedded views.
4. Validate every IPC sender, not just payload shape. Reject messages from a navigation,
   subframe, or remote page that is not authorized for the channel. Do not pass
   arbitrary paths, commands, or URLs from UI to OS APIs.
5. Keep Electron on a supported release. Review available
   [fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) for packaged builds;
   configure them for the app's actual requirements rather than copying an unchecked
   preset. Audit dependencies and avoid shipping secrets in the app.

Sources: [security](https://www.electronjs.org/docs/latest/tutorial/security),
[protocol](https://www.electronjs.org/docs/latest/api/protocol),
[session](https://www.electronjs.org/docs/latest/api/session),
[webContents](https://www.electronjs.org/docs/latest/api/web-contents).

## Test and diagnose

- Run project lint, typecheck, and unit tests. Test renderer UI, preload contracts, IPC
  authorization, window lifecycle, permissions, offline behavior, and failed native
  calls. Add an Electron-aware end-to-end test for critical flows; use the project's
  existing driver or consult the
  [testing guide](https://www.electronjs.org/docs/latest/tutorial/automated-testing).
- Debug renderer code with Chromium DevTools; debug main via `--inspect` /
  `--inspect-brk` and a Node/V8 inspector. Reproduce packaged-only problems in an actual
  distributable on each target OS/architecture; check startup logs, asset paths, CSP,
  sandbox/preload bundling, and native module loading.
- Measure startup and UI responsiveness before optimizing. Keep expensive work off the
  main/UI paths and defer noncritical initialization. If using native Node addons, check
  target OS/architecture and Electron ABI compatibility; use `@electron/rebuild` or
  compatible prebuilds when necessary.
- In a worktree, check whether the build output is a symlink into another checkout
  before packaging. A dev build can succeed through the link, while electron-builder
  omits the output and reports that the main entry file is missing from `app.asar`.
  Replace only the worktree's output link with a local ignored directory, then rebuild;
  never remove the link's target or overwrite another checkout's running dev build.

Sources:
[debug](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process),
[performance](https://www.electronjs.org/docs/latest/tutorial/performance),
[add-ons](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules).

## Package, sign, publish, update

1. Use the existing packaging pipeline. For a new Forge app, `npm run package` creates a
   packaged app; `npm run make` packages it and runs configured makers to create
   OS-specific distributables in `out/make`. For an existing app without Forge, follow
   the [Forge import guide](https://www.electronforge.io/import-existing-project) only
   if adopting Forge is part of the task.
2. Configure makers for each target OS/architecture and inspect what ships: app
   identity, icons, dependencies, assets, licenses, and native addons. Test the
   installed artifact, not only `electron .` or `forge start`. Packaging is not code
   signing and uploading is not auto-update.
3. Sign release artifacts with platform-specific credentials. For macOS outside the App
   Store, follow Developer ID signing and notarization; Mac App Store is a separate
   path. For Windows, use the appropriate code-signing setup. Store keys and credentials
   securely in CI, never in the repository.
4. If distributing updates, design the feed, metadata, signing, rollout, and restart UX
   with the publisher. Electron's built-in `autoUpdater` supports macOS and Windows, not
   Linux. Pick an update mechanism appropriate to the channel; merely running
   `forge publish` does not enable updates. Test a real upgrade from an older signed
   release.
5. Before major upgrades, check Electron's
   [support](https://www.electronjs.org/docs/latest/tutorial/electron-timelines),
   [release schedule](https://releases.electronjs.org/schedule), and
   [breaking changes](https://www.electronjs.org/docs/latest/breaking-changes).
   Rebuild/check native addons and rerun packaged smoke tests across platforms.

### App icons with electron-builder

- A 1024×1024 `build/icon.png` is enough: electron-builder discovers it and converts it
  to the native macOS `.icns` during packaging. Keep an editable SVG source if useful,
  but do not add a custom ICNS generator or an explicit `mac.icon` for this standard
  case. Other packaging tools have different icon conventions.
- For a rounded-square macOS icon, keep the visible artwork around 824×824 within the
  transparent 1024×1024 canvas (about 100 px padding on every side). Check the actual
  Dock appearance, including on macOS Tahoe; artwork reaching the canvas edge can look
  oversized or sit awkwardly on the system's backdrop.
- A packaged macOS app uses its native bundle icon. Only call `app.dock.setIcon` for an
  unpackaged development app if it otherwise shows Electron's icon. Do so after
  `app.whenReady()`, guard `app.dock` for TypeScript/platform safety, and check
  `!app.isPackaged`; overriding a packaged icon with a PNG loses the native treatment.
  The development PNG need not be included in the packaged app's `files` solely for this
  override.
- Validate conversion by packaging an unsigned macOS directory build with
  `electron-builder --mac --dir --publish never -c.mac.identity=null`, then inspect
  `Contents/Resources/icon.icns` and `CFBundleIconFile` in the app's `Info.plist`. This
  checks asset generation, not signing or notarization.

Sources: [icons and images](https://www.electron.build/docs/features/icons-and-images/),
[packaging](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging),
[Forge makers](https://www.electronforge.io/config/makers),
[Forge publishers](https://www.electronforge.io/config/publishers),
[code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing),
[updates](https://www.electronjs.org/docs/latest/tutorial/updates),
[publish](https://www.electronjs.org/docs/latest/tutorial/tutorial-publishing-updating).
