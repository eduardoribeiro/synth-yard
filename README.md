# Synth Yard

An open-source, self-hosted-first platform for managing a multi-brand 3D printer fleet. It replaces manual USB job distribution with centralized status monitoring and automated job dispatch, built to run 24/7 on a dedicated machine on your local network.

Self-hosted by default. An optional managed cloud offering may be introduced later, but self-hosting remains a first-class option without vendor lock-in.

> **Upstream attribution:** Synth Yard is based on [Print Farm Manager](https://github.com/joeltelling/print-farm-manager), originally created by Joel Telling and released under the MIT License.

![Dashboard — live fleet status and active projects](docs/images/dashboard.png)

> **Security note:** This app has no built-in authentication. It is designed to run on a trusted local network only. Do not expose port 3000 (or 5173 in dev) to the internet — your printer API keys are served to any client that can reach the server. Run it behind your router's firewall or a local VPN.

---

## What It Does

- **Live fleet view** — see every printer's status, progress, and time remaining at a glance, auto-refreshing every 15 seconds
- **Automated job dispatch** — define projects and parts, upload G-code, and let the scheduler assign jobs to idle printers automatically
- **Operator confirmation flow** — every finished print requires a human sign-off before the next job dispatches, preventing runaway failures
- **Multi-brand support** — Prusa, Elegoo, Bambu, Klipper, OctoPrint, and compatible Creality printers in the same fleet, managed from one interface
- **CSV fleet import** — add 50 printers at once from a spreadsheet
- **TV dashboard mode** — a heads-up fleet summary designed for a monitor on the shop wall
- **Farm backup and restore** — export your entire farm config and job history as a single JSON file

![Fleet view — per-printer cards with operator confirmation](docs/images/fleet.png)

---

## Supported Printers

| Brand | Protocol | Models |
|---|---|---|
| **Prusa** | PrusaLink REST API | MK4S, XL, and other PrusaLink-compatible models |
| **Elegoo** | SDCP WebSocket (Centauri Carbon) · MQTT (Centauri Carbon 2) | Centauri Carbon, Centauri Carbon 2 |
| **Bambu Lab** | MQTT + FTPS | X1C, P1S, and other Bambu models (with AMS slot selection) |
| **Klipper** | Moonraker REST API | Voron and any Klipper-firmware printer |
| **OctoPrint** | OctoPrint REST API | Any printer running OctoPrint / OctoPi |
| **Creality** | Stock LAN WebSocket + HTTP upload | Ender 3 V3 KE protocol; K1/K1 Max/K1C experimental (hardware validation pending) |

See [Creality setup and compatibility](docs/creality.md) for stock K1 setup.
K2/K2 Plus and CR-M4 are not supported by this connector.

---

## Tech Stack

### Backend
| Package | Role |
|---|---|
| [Node.js](https://nodejs.org) + [Express](https://expressjs.com) | HTTP API server |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Embedded SQLite database — synchronous, zero configuration |
| Native [Fetch API](https://developer.mozilla.org/docs/Web/API/Fetch_API) | HTTP communication with supported printer APIs |
| [mqtt](https://github.com/mqttjs/MQTT.js) | MQTT over TLS for Bambu printer communication |
| [basic-ftp](https://github.com/patrickjuchli/basic-ftp) | FTPS file transfer to Bambu printers |
| [sdcp](https://github.com/blakejrobinson/sdcp) | WebSocket protocol driver for Elegoo SDCP printers |
| [multer](https://github.com/expressjs/multer) | G-code file upload handling |
| [papaparse](https://www.papaparse.com) | CSV fleet import |
| [PM2](https://pm2.keymetrics.io) | Process manager, auto-start on boot and crash recovery |

### Frontend
| Package | Role |
|---|---|
| [React 18](https://react.dev) | UI framework |
| [React Router v6](https://reactrouter.com) | Client-side routing |
| [Vite](https://vitejs.dev) | Build tool and dev server |
| [TypeScript](https://www.typescriptlang.org) | Gradual static typing for client and server migrations |
| [OXC](https://oxc.rs) | Fast linting and code formatting |

### Data
| Technology | Role |
|---|---|
| SQLite (via better-sqlite3) | Single-file embedded database — no database server required |

---

## Quick Start (Development)

Use **Node.js 26** (pinned to **26.8.1** in `.nvmrc` and `.node-version`) and
**pnpm 12.3.4**. With nvm, run `nvm install` and `nvm use`. Install pnpm once:

```bash
npm install --global pnpm@12.3.4
```

The server and Vite client share one pnpm workspace and `pnpm-lock.yaml`.
Run installation from the repository root; it installs both packages.

```bash
git clone https://github.com/eduardoribeiro/synth-yard.git
cd synth-yard
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

- API server: `http://localhost:3000`
- Web UI (hot reload): `http://localhost:5173`

### Prefer Docker instead of a local Node.js install?

```bash
git clone https://github.com/eduardoribeiro/synth-yard.git
cd synth-yard
docker compose up --build synth-yard-dev
```

- API server: `http://localhost:3000`
- Web UI (hot reload): `http://localhost:5173`

Run tests with `docker compose exec synth-yard-dev pnpm test`. See the `dev` service in `docker-compose.yml` for details.

---

## Installation (Production)

### Option A — Docker (recommended)

Requires [Docker](https://docs.docker.com/get-docker/) (and Compose, bundled with Docker Desktop and modern Docker Engine installs).

#### Quickest start — pull the published image

No clone, no local build. A multi-arch image (`linux/amd64` + `linux/arm64`) is published automatically to GitHub Container Registry on every release — see [docs/docker-publish.md](docs/docker-publish.md). Save this as `docker-compose.yml`:

```yaml
services:
  synth-yard:
    image: ghcr.io/eduardoribeiro/synth-yard:latest
    container_name: synth-yard
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - farm-data:/app/server/data
      - farm-gcode:/app/server/gcode

volumes:
  farm-data:
  farm-gcode:
```

```bash
docker compose up -d
```

This same file works as a drop-in stack in Portainer (**Stacks → Add stack → Web editor**, paste it in, deploy) — no repo checkout needed there either.

Open `http://localhost:3000` in a browser, or replace `localhost` with the machine's LAN IP to access it from any device on the network.

**Updating** to the latest published image:

```bash
docker compose pull
docker compose up -d
```

**Useful commands:**

| Command | What it does |
|---|---|
| `docker compose logs -f` | Follow server logs |
| `docker compose stop` | Stop the container (data is preserved) |
| `docker compose up -d` | Start it again |
| `docker compose down` | Stop and remove the container (volumes are preserved) |

Pin to a specific release instead of always tracking `latest` by using a version tag, e.g. `ghcr.io/eduardoribeiro/synth-yard:1.2.0`. `edge` tracks the latest build of `main` between releases.

#### Building from source instead

If you're testing local changes rather than running a release, clone the repo and build with the `docker-compose.yml` at its root (uses `build:` instead of `image:`):

```bash
git clone https://github.com/eduardoribeiro/synth-yard.git
cd synth-yard
docker compose up -d --build
```

Updating this path pulls new source and rebuilds:

```bash
git pull
docker compose up -d --build
```

Without Compose, the equivalent `docker run` (published image) is:

```bash
docker run -d --name synth-yard --restart unless-stopped \
  -p 3000:3000 \
  -v farm-data:/app/server/data \
  -v farm-gcode:/app/server/gcode \
  ghcr.io/eduardoribeiro/synth-yard:latest
```

> Same security note as above applies inside Docker: only publish port 3000 to interfaces on your trusted LAN, not `0.0.0.0` on an internet-facing host.

### Option B — Bare metal (Node.js on the host)

For a full walkthrough covering prerequisites, network setup, auto-start with PM2, backup, updating, and troubleshooting on both Windows and macOS, see the **[Installation Guide](docs/installation.md)**.

The short version:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open `http://localhost:3000` in a browser, or replace `localhost` with the machine's LAN IP to access it from any device on the network.

---

## CSV Import Format

The fastest way to add a large fleet is via CSV import on the Settings page.

| Column | Required | Example |
|---|---|---|
| `name` | Yes | `MK4S_01` |
| `ip` | Yes | `192.168.1.100` |
| `type` | Yes | `prusa` / `elegoo-centauri` / `elegoo-centauri2` / `bambu` / `klipper` / `octoprint` / `creality` |
| `api_key` | Prusa and OctoPrint (API key), Bambu and Centauri Carbon 2 (LAN access code) | `aK3jR7xQ2pLm9vN` |
| `serial_number` | Bambu and Centauri Carbon 2 | `01S00C123456789` |
| `group` | No | `MK4S Farm` |
| `model` | No | `mk4s` |

If the `model` column is omitted, the model is inferred automatically from the printer name where possible; unrecognised models prompt for manual selection after import.

---

## Project Structure

```
synth-yard/
├── server/
│   ├── index.js          # Express entry point
│   ├── db.js             # SQLite schema + migrations
│   ├── poller.js         # 15-second printer poll loop
│   ├── scheduler.js      # Job dispatch engine
│   └── drivers/          # Per-brand printer drivers
│       ├── prusa.js       # PrusaLink REST
│       ├── elegoo-centauri.js   # SDCP WebSocket (Centauri Carbon)
│       ├── elegoo-centauri2.js  # MQTT + chunked HTTP PUT (Centauri Carbon 2)
│       ├── bambu.js       # MQTT + FTPS
│       ├── klipper.js     # Moonraker REST
│       ├── creality.js    # Stock LAN WebSocket + HTTP upload
│       └── octoprint.js   # OctoPrint REST
├── client/               # React + Vite frontend
├── docs/                 # Full documentation
├── Dockerfile            # Multi-stage: server-deps/client-build/runtime (production) + dev
└── docker-compose.yml    # Production container + persistent volumes, plus an opt-in `dev` profile
```

---

## License

MIT
