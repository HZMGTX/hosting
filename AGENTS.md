# AGENTS.md

## Project Overview
**OmniHost** is a self-hosted control panel that runs Discord bots, web apps, static sites, workers and custom commands 24/7. A Node.js + Express + WebSocket backend spawns and supervises real child processes; a vanilla-JS dashboard manages them (console, editor, deploys, backups, metrics, alerts, team accounts).

## Tech Stack & Architecture
- **Backend**: Node.js 24, Express 5, `ws` for realtime, `multer` + `adm-zip` for uploads, `pidusage` for real CPU/RAM, `qrcode` for 2FA setup, `@anthropic-ai/sdk` for the optional AI assistant, built-in `node:sqlite` for per-service databases.
- **Frontend**: vanilla ES modules + plain CSS (tokens, light/dark). No frameworks, no bundler, no build step. Only `public/` is served.
- **Persistence**: one JSON document (`database.json`) written atomically by `db.js`; service files under `hosted_bots/<id>/`; logs, backups, metrics and SQLite files under `.omnihost/`. All of it lives in `DATA_DIR` (project folder locally, `/data` in Docker).

### Directory structure
- `server.js` — Express app, route mounting, security headers, WebSocket hub, boot/shutdown.
- `db.js` — cached JSON store with debounced atomic saves and the v1 → v2 migration.
- `lib/` — backend modules:
  - `config.js` (env vars), `safePath.js` (id/path validation — use for every user path), `envFile.js` (.env editing that preserves other keys), `errors.js`
  - `auth.js` (users, sessions, roles/permissions, API tokens, rate limits), `totp.js` (2FA), `audit.js`, `notify.js` (notifications + Discord/HTTP alerts), `bus.js`
  - `processManager.js` (lifecycle, restart policy/backoff, crash-loop guard, stats, health checks), `services.js` (folders, env assembly, ports), `exec.js` (no-shell command running), `installer.js` (npm/pip), `logStore.js`, `diagnostics.js`, `metrics.js`
  - `git.js`, `pipeline.js` (deploy/rollback/commands), `backups.js`, `deploys.js`, `scheduler.js` + `cron.js`, `proxy.js` (`/apps/<id>/` + custom domains), `sqlite.js`, `discordApi.js`, `aiAssist.js`, `templates.js`, `apiDocs.js`
  - `monitors.js` (external HTTP/keyword/TCP uptime checks), `panelTransfer.js` (whole-panel export/import; never includes accounts)
  - `serviceModel.js` `PORTABLE_FIELDS` lists the settings that travel with duplicate/export/import — add new portable settings there.
  - `templates/` — starter projects; `templates/_features/` — Discord feature packs.
- `routes/` — `auth`, `account`, `users`, `services`, `files`, `env`, `monitors`, `system` (incl. panel export/import), `public` (status + GitHub webhook).
- `public/` — `index.html`, `status.html`, `css/`, `js/` (`main.js`, `ui.js` DOM helpers, `api.js`, `store.js`, `ws.js`, `router.js`, `shell.js`, `palette.js`, `components/` editor/highlighter/chart, `pages/` and `pages/tabs/`).
- `test/` — `node:test` suites (`npm test`).
- `Dockerfile`, `docker-entrypoint.sh`, `railway.json`, `.env.example`, `.github/workflows/ci.yml`.

## Development & Execution
- Install: `npm install`
- Run: `node server.js` (or `START_HOSTING.bat`), then open http://localhost:3000
- Test: `npm test`
- Deploy: Docker image (see README) — Railway with a volume at `/data`. Vercel is not suitable (no long-running processes or WebSockets).

## Key Conventions & Constraints
- **Spawning**: always `spawn(cmd, args, { cwd: serviceDir, shell: false })`. Never build shell strings; parse user command lines with `exec.splitArgs` and resolve `node`/`npm`/`python` with `exec.resolveCommand`/`npmCommand` (npm runs via `npm-cli.js` because `.cmd` shims need a shell on Windows).
- **Paths**: every user-supplied service id goes through `assertId`/`isValidId`; every relative path through `resolveInside`.
- **Secrets**: live only in each service's `.env` (or env groups in the DB). Never mirror tokens to `localStorage`, never return them unmasked unless `reveal=1` by an editor, and strip panel-only env vars (`config.PANEL_ONLY_ENV`) from child processes.
- **Frontend safety**: build DOM with `h()` from `public/js/ui.js` (textContent only). No `innerHTML` with dynamic data, no inline scripts/handlers (CSP forbids them).
- **Permissions**: check `auth.can(user, perm, serviceId)` (server) / `store.can()` (client). Roles: owner > admin > developer (assigned services) > viewer (read-only).
- **Writes from the browser** must send `X-Omnihost: 1` (CSRF guard); `api.js` does this.
- **Audit**: record security-relevant actions with `audit.record(req, action, target, details)`.
