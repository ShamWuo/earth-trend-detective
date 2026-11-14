# Earth Trend Detective (`ETG`)

> **NASA Space Apps Challenge** — A communal, AI-native **Earth Trend Graph (`ETG`)** and interactive Earth-timeline visualizer for discovering, corroborating, and explaining scientific trends across the planet.

## Key Capabilities

- **View 1 — Interactive 3D Earth Globe**: Geo-pinned (`lat`, `lng`) observations, cross-region `drives_opposite` teleconnection arcs, and click-anywhere coordinate probing against **NASA POWER / MERRA-2** time-series.
- **View 2 — Coalesced Earth Trend Graph (`ETG`)**: Dual 3D WebGL & 2D Editorial Canvas force-directed graph built on a strict scientific ontology (`Concept`, `Signal`, `Insight`, `Rule`), surfacing opposite-trend dipoles and **Epistemic Belief Revision** (`supersedes` lineage).
- **Statistical Significance Engine**: Exact tie-corrected **Mann-Kendall** test (`p-value`, $Z_{MK}$, $\tau$) and **Theil-Sen** median slope estimator with 95% confidence intervals and cross-region correlation ($r$, $\rho$).
- **Communal & AI-Native Ingestion**:
  - **MCP Streamable HTTP & SSE**: `/api/mcp`, `/api/mcp/sse`, `/api/mcp/messages`
  - **OpenAPI 3.1.0 Spec**: `/api/mcp/openapi`
  - **Hardware / Camera Webhooks**: `/api/graph/nodes/[nodeId]/webhook`
  - **Live NASA EONET Sync**: `POST /api/earth/eonet`

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Verification

```bash
npm run typecheck
npm test
npm run build
```

See [AGENTS.md](AGENTS.md) and [EARTH_TREND_DETECTIVE.md](EARTH_TREND_DETECTIVE.md) for architecture details.
