# OmniHost

Self-hosted control panel that runs **Discord bots, web apps, static sites and background workers 24/7** — with a live console, code editor, GitHub deploys, backups, metrics, alerts and team accounts.

## Run it on your PC

1. Install [Node.js 22.13+](https://nodejs.org) (24 recommended).
2. Double-click `START_HOSTING.bat` (or run `npm install` then `npm start`).
3. Open http://localhost:3000 and create your owner account.

Locally the panel only listens on `127.0.0.1`, so nobody else on your network can reach it.

## Put it online (Railway — recommended)

Vercel can't host this: it only runs short serverless functions, so bots would go offline and the live console wouldn't work. Railway runs the included Dockerfile as an always-on server.

1. Push this folder to a **private** GitHub repository (`.gitignore` already keeps bots, secrets and the database out of git).
2. On [railway.com](https://railway.com): **New Project → Deploy from GitHub repo** → pick the repo. It builds the `Dockerfile` automatically.
3. In the service: **Settings → Volumes → Add volume**, mount path **`/data`**. Without a volume every redeploy wipes your bots.
4. **Settings → Networking → Generate Domain** (or add your own domain).
5. Optional **Variables**: `PUBLIC_URL=https://your-domain`, `ANTHROPIC_API_KEY=…` for the AI assistant.
6. Open the URL and create your owner account **immediately** — the first visitor becomes the owner.
7. Turn on two-factor login under **My account**.

To move everything from your PC: on the local panel open **Panel settings → Move to another server → Download export**, then on the Railway panel (after creating your owner account) choose **Import**. Services, `.env` secrets, settings and SQLite data all come across; accounts don't. Delete the export file afterwards — it contains your tokens.

### Other hosts

- **Render**: New → Web Service → Docker. Add a Disk mounted at `/data`. Use a paid instance (free ones sleep).
- **Fly.io**: `fly launch` (uses the Dockerfile), then `fly volumes create data` and mount it at `/data` in `fly.toml`.
- **VPS** (Ubuntu): install Docker, then
  `docker run -d --restart unless-stopped -p 3000:3000 -v omnihost:/data --name omnihost $(docker build -q .)`
  and put [Caddy](https://caddyserver.com) in front for HTTPS: `your-domain.com { reverse_proxy localhost:3000 }`.

## Configuration

All settings are environment variables — see [`.env.example`](.env.example). None are required locally.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Panel port |
| `HOST` | 127.0.0.1 locally, 0.0.0.0 in Docker | Listen address |
| `DATA_DIR` | project folder / `/data` | Where everything is stored |
| `PUBLIC_URL` | — | Panel URL shown in links |
| `SESSION_SECRET` | auto-generated | Server secret |
| `ANTHROPIC_API_KEY` | — | Enables the AI crash assistant |

## What it does

- **Services**: Discord bots (Node or Python), Telegram bots, web apps (Express or Flask; get a `PORT`, served at `/apps/<id>/` or a custom domain), static sites, workers, or any custom command. Build commands (`npm run build`) run on deploy or before start. Duplicate, tag, bulk start/stop, and export a service as a ZIP that re-imports with its settings.
- **ZIP uploads**: unzipped straight into the main folder, wrapper folders and junk removed, start file detected.
- **24/7**: auto-restart with backoff, crash-loop protection, health checks, services come back after the panel restarts.
- **Console**: live stdout/stderr with colours, search across saved logs, stdin.
- **Editor**: file tree, tabs, syntax highlighting, find/replace, uploads (files, folders, ZIPs).
- **Diagnostics**: recognises bad tokens, missing intents, missing packages, syntax errors, port clashes — with one-click fixes. Optional Claude-powered fix suggestions.
- **Deploys**: GitHub clone/pull with push webhooks, deploy history with one-click rollback, backups.
- **Packages**: npm and pip management, per-service Python virtualenvs, scripts runner.
- **Data**: a built-in SQLite database per service, shared variable groups.
- **Monitoring**: CPU/RAM history, uptime, external uptime monitors (HTTP, keyword, TCP port), Discord/HTTP webhook alerts, desktop notifications, public `/status` page.
- **Discord tools**: bot profile, intents checker, invite builder, server list (with leave), feature packs.
- **Packages**: npm/pip management plus security audit (`npm audit` with one-click fix, `pip check`).
- **Moving servers**: whole-panel export/import (Panel settings).
- **Teams**: owner/admin/developer/viewer roles, invite links, 2FA, API tokens, audit log.

## Security notes

- Only `public/` is served; secrets live in each service's `.env` and are masked in the UI.
- Every file path is checked to stay inside its service folder; ZIP uploads are validated before extraction.
- Hosted apps at `/apps/<id>/` run sandboxed so their JavaScript can't use your panel session.
- Hosted code runs on the same machine as the panel. Only give developer access to people you trust.

## Development

```bash
npm install
npm test
```

Tests start the real server against a temporary data folder (`test/api.test.js`) and cover the security helpers (`test/unit.test.js`).
