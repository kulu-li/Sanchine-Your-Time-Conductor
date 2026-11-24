# Hong Kong deployment

Current plan: Tencent Cloud Lighthouse, Hong Kong, Ubuntu 26.04, 2C2G.
Inbound SSH from our network is blocked, so deployment runs from the
Tencent Cloud **web terminal** (OrcaTerm).

## What the bootstrap does

1. Installs Node 26 and cloudflared.
2. Creates `/opt/sancine`, extracts the app bundle, creates the `sancine` user.
3. Creates `/etc/sancine.env` with a fresh setup token and SQLite path.
4. Runs the app on `127.0.0.1:8787` under systemd.
5. Starts a Cloudflare **quick tunnel** to the app.
6. Adds a daily SQLite backup cron.
7. Prints the public `trycloudflare.com` URL and the setup token.

No inbound 80/443 is needed. The server only makes outbound connections.

## Run on the server

In the Tencent Cloud web terminal:

```bash
curl -fsSL <deploy-url>/bootstrap.sh | sudo bash
```

Then open the printed `https://...trycloudflare.com` URL, enter the setup token,
create the admin account, and the existing `data/state.json` is imported into
your workspace.

## Build the bundle locally

```bash
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build
node scripts/build-sw.mjs
./deploy/build-bundle.sh /tmp/sancine-deploy
```

The bundle intentionally excludes `node_modules`, `data/app.db`, passcodes,
and setup tokens.
