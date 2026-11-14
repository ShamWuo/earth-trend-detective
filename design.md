# Earth Trend Detective (`ETG`) — Design System & Technical Specification

> **NASA Space Apps Challenge** · Communal, AI-Native **Earth Trend Graph (`ETG`)** & Dual-View Earth-Timeline Visualizer

---

## 1. Dual-View Architecture

1. **View 1 — Interactive 3D Earth + Timeline Scrubber + Dataset Selector**
   - Textured Three.js Earth globe displaying geo-pinned (`lat`, `lng`) observations, anomalies, and cross-region teleconnection arcs.
   - Clicking any coordinate queries **NASA POWER / MERRA-2** multi-year time-series (with deterministic climatological fallback when offline) and runs the **Statistical Trend Engine**:
     - **Mann-Kendall (`p-value`, $Z_{MK}$, $\tau$)** to distinguish statistically significant directional shifts ($p < 0.05$) from normal environmental variability.
     - **Theil-Sen Robust Slope** ($\hat{\beta}$ with 95% confidence interval) immune to single-season outliers.
   - Timeline scrubber (`observed_at`) replays how trends emerged, corroborated across independent sources, and evolved over time.
   - Dataset selector toggles across `nasa_power`, `wildfire`, `ocean_temp`, `air_quality`, `deforestation`, `hydrology`, and `community` layers.

2. **View 2 — Coalesced AI-Native Earth Trend Graph (`ETG`)**
   - Smooth `document.startViewTransition` switch where active geo-pinned signals coalesce into a connected knowledge graph (both 3D WebGL force-directed space and 2D Editorial Hairline Canvas).
   - **Scientific Ontology** (4 core labels):
     - `Concept`: Regions, coupled Earth systems, satellites, and community hardware (edge cameras, IoT sensors).
     - `Signal`: Timestamped observations (`lat`, `lng`, `dataset`, `confidence`, `observed_at`).
     - `Insight`: Detected scientific trends and cross-region teleconnections (`drives_opposite`, `correlates_with`).
     - `Rule`: Scientific corroboration & statistical gates (e.g., $\ge 2$ independent producer classes).
   - **Epistemic Belief Revision**: New scientific evidence links via `supersedes` edges so the graph preserves *how* and *why* a scientific conclusion evolved without erasing prior hypotheses.

3. **Communal, Hardware-Agnostic & AI-Native Ingestion**
   - **MCP Streamable HTTP & SSE** (`/api/mcp`, `/api/mcp/sse`, `/api/mcp/messages`) + **OpenAPI 3.1.0** (`/api/mcp/openapi`) for external AI agents.
   - **Hardware Webhooks** (`/api/graph/nodes/[nodeId]/webhook`) for ESP32, Raspberry Pi, ridge cameras, and community air/water sensors.
   - **NASA Open APIs** (`/api/earth/timeseries`, `/api/earth/eonet`) for live satellite corroboration.

---

## 2. Visual Aesthetics: Editorial Broadsheet & Hairline Ledger

- **Obsidian Dark (`#161617` / `#1f1f21`) & Warm Ivory (`#fafafa` / `#f4f4f5`)** themes synced with `<meta name="color-scheme" content="light dark">` and CSS `color-scheme`.
- **Crisp Hairline Rules**: `1px solid var(--border)` structural dividers, `tabular-nums` (`.ws-numeric`) on all p-values, slopes, and coordinates, and clean matte cards (`.ws-card`) without SaaS bloat.
- **Native Web Platform Primitives**: Native `<dialog>` with `closedby="any"` + bounding-box light-dismiss fallback, native `<input type="range">` timeline scrubber, container-queried responsive telemetry tables (`@container`), and `document.startViewTransition()` focus routing.
