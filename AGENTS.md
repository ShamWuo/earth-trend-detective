# Earth Trend Detective — Agent Instructions (`AGENTS.md`)

## Core Identity (Read This First)
This repository is **Earth Trend Detective**, an **entirely separate application** built for the **NASA Space Apps Challenge**.

- **100% Scientific & Earth Trends Focus**: Every feature, data model, UI view, and API in this codebase exists solely to detect, visualize, corroborate, and explain **Earth and scientific trends** (climate, wildfires, ocean anomalies, air quality, canopy/NDVI, hydrology, atmospheric shifts).
- **Do NOT Build Blueprint's SaaS Features**: Do **not** re-create Blueprint's productivity/software-engineering concepts (`Variable` nodes, `Logic` gates, `Task`, `Goal`, `Doc`, `Note`, `Project`, `Calendar`, `Billing`, or `BKN` naming). Use **Earth Trend Graph (`ETG`)** terminology.
- **Reference Blueprint Only for Inspiration**: When you need design or technical inspiration for the 3D/2D graph canvas, shader/force layout, Obsidian Dark UI tokens, or MCP tool patterns, you may read `/Users/swum/Desktop/Projects/blueprint` (e.g., `apps/web/src/components/dashboard/KnowledgeGraph3D.tsx`, `KnowledgeGraph2D.tsx`, `packages/mcp-server/`), **then adapt cleanly for scientific Earth trends here**.

---

## Product Architecture
1. **View 1 — Interactive Earth + Timeline Scrubber + Dataset Selector**
   - 3D Earth globe displaying geo-pinned (`lat`, `lng`) scientific observations and anomalies; clicking any point queries **NASA POWER / MERRA-2** (or **FIRMS / EONET**) time-series.
   - Timeline scrubber (`observed_at`) to replay how trends emerged, spread, or subsided over time.
   - Dataset selector (NASA POWER climate variables, FIRMS wildfire thermal, PM2.5 air quality, Sea Surface Temp anomaly, MODIS NDVI canopy, community sensors).
   - **Statistical Significance Engine**: Compute **Mann-Kendall (`p-value`)** and **Theil-Sen slope** (rate of change) on every time-series to distinguish real trends from normal environmental variability.
2. **View 2 — Coalesced AI-Native Earth Trend Graph (`ETG`)**
   - Smooth transition where active geo-pinned Earth signals coalesce into a connected knowledge graph, explicitly surfacing **cross-region opposite trends** driven by shared Earth processes.
   - **Scientific Ontology**:
     - `Concept`: Regions, Earth systems, satellites, and community hardware (cameras, IoT sensors).
     - `Signal`: Timestamped scientific observations (`lat`, `lng`, `dataset`, `confidence`, `observed_at`).
     - `Insight`: Detected scientific trends and cross-region correlations (e.g., ENSO teleconnections).
     - `Rule`: Scientific corroboration & verification gates (e.g., ≥2 independent sources).
   - **Epistemic Belief Revision**: New observations link via `supersedes` edges so the graph preserves *how* and *why* a scientific conclusion evolved.
3. **Communal, Hardware-Agnostic & AI-Native Ingestion**
   - Open for community sensors, edge cameras, NASA open APIs, and any AI model (via MCP / REST webhooks) to read and mutate the graph with full provenance.

---

## Template Files
- [EARTH_TREND_DETECTIVE.md](EARTH_TREND_DETECTIVE.md) — Challenge goals, dual-view spec, and ingestion design.
- [design.md](design.md) & [src/app/globals.css](src/app/globals.css) — Obsidian Dark / Warm Ivory UI theme tokens.
- [src/data/seededEarthGraph.ts](src/data/seededEarthGraph.ts) — Starter scientific Earth Trend graph data.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
