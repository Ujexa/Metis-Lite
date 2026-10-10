# Metis Lite release checklist

Use this checklist on the machine that will run or publish Metis Lite. The source archive intentionally excludes `node_modules` and generated `dist` output; install dependencies and build from the lockfile instead of copying an existing dependency folder.

## 1. Prepare a clean install

In Windows PowerShell, open this project folder and run:

```powershell
node --version
corepack enable
corepack prepare pnpm@10.18.0 --activate
pnpm --version
pnpm install --frozen-lockfile
```

Use Node.js 22 or newer. `pnpm --version` should report `10.18.0` before installing. If dependency installation fails, keep the complete terminal error; do not copy `node_modules` from another machine to work around it.

## 2. Run release gates

```powershell
pnpm check
pnpm test
pnpm build
```

All three commands must finish successfully. Do not treat old logs or cached test output as a fresh pass.

## 3. Smoke-test the production build

```powershell
pnpm start
```

Open `http://127.0.0.1:3000`. Confirm that the workspace loads and `http://127.0.0.1:3000/api/health` returns `{"status":"ok"}`. An unknown `/api/...` path should return a JSON 404, not the app's HTML page.

## 4. Exercise important user workflows

- Import a selectable-text PDF, a scanned/image-based PDF if available, a text/Markdown file, a CSV, and an image. Check that unsupported or unreadable files fail clearly.
- Save a study kit or library item, refresh the page, and confirm it persists in the same browser.
- Test local study features without an OpenRouter key. Then test AI generation and independent verification with your own key, including an invalid key or provider error. Review usage and billing before large imports.
- Confirm that ending the browser session clears the session-stored API key, and that no key is committed to source control or included in a ZIP.
- After an initial online load, test the app shell with networking disabled. Expect AI calls and live 3D-model search to require an internet connection.
- Check the interface at a narrow/mobile viewport and at normal desktop width.
- Search the 3D model atlas online, inspect a result's source/license information, and confirm the failure message is understandable when upstream sources are unavailable.

## 5. Before publishing or deploying

- Confirm the copyright holder listed in `LICENSE` is correct for the public release.
- Keep `.env`, API keys, `node_modules`, caches, and generated `dist` output out of the source ZIP/repository. The build output should be generated from this source and lockfile.
- The server binds to `127.0.0.1` by default. Set `HOST=0.0.0.0` only when a container or other machine needs to reach it.
- Keep `TRUST_PROXY_HOPS=0` unless a trusted reverse proxy is configured. If using a proxy, set the exact hop count and prevent direct access to the app; configure a platform-level rate limit as well for public or multi-instance deployments.
- Do not publish until the clean install, checks, build, and manual workflows above have passed.
