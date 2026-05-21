# WE-CRYPTO (WE-CFM-Orchestrator)

WE-CRYPTO is an Electron-based crypto prediction and orchestration app for 15-minute Kalshi market analysis, live multi-source signal aggregation, and adaptive model tuning. It uses a self-teaching three-layer learning stack (real-time, snapshot, and walk-forward) over a multi-signal prediction engine, continuously retuning weights from recent accuracy feedback during live operation.

Project page: [View on GitHub](https://github.com/JohnDaWalka/WE-CFM-Orchestrator)

## Quick Start
- Install: `npm install`
- Configure credentials/environment: see [Configuration](./docs/CONFIGURATION.md) and [Getting Started](./docs/GETTING-STARTED.md)
- Run: `npm start`
- Build (portable): `npm run build:portable`
- Build (installer): `npm run build:installer`
- Production/release builds (with preflight checks): `npm run build:portable:release` and `npm run build:installer:release`

## Documentation
- [Architecture](./docs/ARCHITECTURE.md)
- [Signals](./docs/SIGNALS.md)
