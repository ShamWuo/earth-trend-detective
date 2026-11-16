"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GraphCameraDock } from "@/components/GraphCameraDock";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  computeLayout2D,
  computeRegionClusters2D,
  formatEdgeRelationLabel,
  MAX_ZOOM,
  type Point2D,
  resolveDetailTier,
  resolveEtgEdgeColor,
  resolveEtgNodeColor,
  type ScreenEdgePillCandidate,
  type ScreenLabelCandidate,
  selectNonOverlappingEdgePills,
  selectNonOverlappingLabels,
  wheelZoomStep,
} from "@/lib/graph/graphVisuals";
import { humanizeNodeText } from "@/lib/plainLanguage";
import type { ETGEdge, ETGNode } from "@/types/etg";
import {
  computeDotRadius2D,
  Graph2DMinimap,
  Graph2DNodeItem,
  Graph2DSvgDefs,
} from "@/components/graph/GraphCanvas2DSvgDefsAndNodes";
import {
  buildDipoleNodeSet,
  buildNeighborMap,
  buildSearchMatchSet,
  dispatchNodeSelectOrQuickConnect,
  type GraphCanvasProps,
  intersectBoxBorder,
  resolveMicroscopeNodeBadge,
} from "@/components/graph/graphViewShared";

interface PreparedEdge2D {
  edge: ETGEdge;
  edgePath: string;
  strokeColor: string;
  strokeWidth: number;
  opacity: number;
  isOpposite: boolean;
  isSupersedes: boolean;
  markerEndId: string;
  markerStartId?: string;
  pillX: number;
  pillY: number;
  pillLabel: string;
}

/**
 * 2D Interactive SVG Earth Trend Knowledge Graph with semantic zoom (dots vs 248x64 cards),
 * draggable node overrides, de-overlapped Bezier pills, candidate ghost arcs, and minimap.
 */
export function GraphCanvas2D({
  nodes,
  edges,
  selectedNodeUuid,
  selectedEdgeUuid,
  cascadeEdgeUuids,
  searchQuery,
  isLightTheme,
  candidateLinks = [],
  traversalFilter,
  roleByNode = {},
  hopByNode = {},
  microscopeByNode = {},
  connectMode = false,
  connectSourceUuid = null,
  selectedRegionScope = null,
  regionSpotlight = null,
  regionFocusNonce = 0,
  onChangeRegionScope,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
  onStartQuickConnect,
  onAcceptCandidateLink,
}: GraphCanvasProps) {
  const cascadeEdgeSet = useMemo(() => new Set(cascadeEdgeUuids), [cascadeEdgeUuids]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1200, height: 800 });
  const layoutMode = traversalFilter?.layoutMode ?? "force";

  const { positions: basePositions, bounds } = useMemo(
    () =>
      computeLayout2D(nodes, edges, {
        mode: layoutMode,
        rootUuid: selectedNodeUuid,
        roleByNode,
        hopByNode,
      }),
    [nodes, edges, layoutMode, selectedNodeUuid, roleByNode, hopByNode]
  );

  // User-dragged node overrides (cleared cleanly when node set or layout mode changes)
  const [dragOverrides, setDragOverrides] = useState<Map<string, Point2D>>(() => new Map());
  useEffect(() => {
    setDragOverrides(new Map());
  }, [basePositions]);

  const positions = useMemo(() => {
    if (dragOverrides.size === 0) return basePositions;
    const merged = new Map(basePositions);
    for (const [id, pt] of dragOverrides.entries()) {
      merged.set(id, pt);
    }
    return merged;
  }, [basePositions, dragOverrides]);

  const regionClusters2D = useMemo(
    () => computeRegionClusters2D(nodes, positions),
    [nodes, positions]
  );

  const [camera, setCamera] = useState({ panX: 0, panY: 0, zoom: 0.94 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const cameraAnimRef = useRef<number | null>(null);
  const hasRightPanel = Boolean(selectedNodeUuid || selectedEdgeUuid || connectSourceUuid);

  const cancelCameraAnim2D = useCallback(() => {
    if (cameraAnimRef.current !== null) {
      cancelAnimationFrame(cameraAnimRef.current);
      cameraAnimRef.current = null;
    }
  }, []);

  const animateCamera2D = useCallback(
    (target: { panX: number; panY: number; zoom: number }, durationMs = 300) => {
      cancelCameraAnim2D();
      const reduced =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (reduced || durationMs <= 0) {
        setCamera(target);
        return;
      }
      const start = { ...cameraRef.current };
      const t0 = performance.now();
      const step = (now: number) => {
        const raw = Math.min(1, (now - t0) / durationMs);
        const ease = 1 - Math.pow(1 - raw, 3);
        setCamera({
          panX: start.panX + (target.panX - start.panX) * ease,
          panY: start.panY + (target.panY - start.panY) * ease,
          zoom: start.zoom + (target.zoom - start.zoom) * ease,
        });
        if (raw < 1) {
          cameraAnimRef.current = requestAnimationFrame(step);
        } else {
          cameraAnimRef.current = null;
        }
      };
      cameraAnimRef.current = requestAnimationFrame(step);
    },
    [cancelCameraAnim2D]
  );

  useEffect(() => cancelCameraAnim2D, [cancelCameraAnim2D]);

  // Fit graph into container, reserving right inset for the open workbench drawer
  const recenterToFit = useCallback(
    (animate = false) => {
      const { width, height } = viewportSize;
      const rightInset = hasRightPanel && width >= 900 ? (width >= 1280 ? 496 : 456) : 0;
      const usableWidth = Math.max(320, width - rightInset);
      const graphW = Math.max(320, bounds.maxX - bounds.minX + CARD_WIDTH + 32);
      const graphH = Math.max(240, bounds.maxY - bounds.minY + CARD_HEIGHT + 48);
      const fitZoom = Math.max(
        1e-5,
        Math.min(1.08, Math.min((usableWidth * 0.86) / graphW, (height * 0.78) / graphH))
      );
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      const nextCam = {
        panX: -cx * fitZoom - rightInset / 2 + (width >= 900 ? 40 : 0),
        panY: -cy * fitZoom - 16,
        zoom: fitZoom,
      };
      if (animate) {
        animateCamera2D(nextCam, 360);
      } else {
        cancelCameraAnim2D();
        setCamera(nextCam);
      }
    },
    [bounds, viewportSize, hasRightPanel, animateCamera2D, cancelCameraAnim2D]
  );

  const panToRegion2D = useCallback(
    (clusterId: string) => {
      const target = regionClusters2D.find((c) => c.id === clusterId);
      if (!target) return;
      const rightInset =
        hasRightPanel && viewportSize.width >= 900
          ? viewportSize.width >= 1280
            ? 496
            : 456
          : 0;
      const focusZoom = Math.max(
        0.86,
        Math.min(1.18, cameraRef.current.zoom < 0.8 ? 0.96 : cameraRef.current.zoom)
      );
      animateCamera2D({
        panX: -target.centroid.x * focusZoom - rightInset / 2,
        panY: -target.centroid.y * focusZoom,
        zoom: focusZoom,
      });
    },
    [regionClusters2D, hasRightPanel, viewportSize.width, animateCamera2D]
  );

  const prevRegion2DRef = useRef<string | null>(null);
  const prevRegionFocusNonce2DRef = useRef<number>(regionFocusNonce);
  useEffect(() => {
    if (
      selectedRegionScope === prevRegion2DRef.current &&
      regionFocusNonce === prevRegionFocusNonce2DRef.current
    ) {
      return;
    }
    const hadPrevRegion = prevRegion2DRef.current !== null;
    prevRegion2DRef.current = selectedRegionScope;
    prevRegionFocusNonce2DRef.current = regionFocusNonce;
    if (selectedRegionScope) {
      panToRegion2D(selectedRegionScope);
    } else if (hadPrevRegion) {
      recenterToFit(true);
    }
  }, [selectedRegionScope, regionFocusNonce, panToRegion2D, recenterToFit]);

  const [hoveredNodeUuid, setHoveredNodeUuid] = useState<string | null>(null);
  const [hoveredEdgeUuid, setHoveredEdgeUuid] = useState<string | null>(null);
  const [pointerWorldPos, setPointerWorldPos] = useState<Point2D | null>(null);

  useEffect(() => {
    if (!connectSourceUuid) {
      setPointerWorldPos(null);
    }
  }, [connectSourceUuid]);

  const nodeById2D = useMemo(() => {
    const map = new Map<string, ETGNode>();
    for (const n of nodes) map.set(n.uuid, n);
    return map;
  }, [nodes]);

  const neighborMap = useMemo(() => buildNeighborMap(nodes, edges), [nodes, edges]);
  const matchingUuids = useMemo(() => buildSearchMatchSet(nodes, searchQuery), [nodes, searchQuery]);
  const dipoleNodeUuids2D = useMemo(() => buildDipoleNodeSet(edges), [edges]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const updateSize = () => {
      setViewportSize({
        width: el.clientWidth || 1200,
        height: el.clientHeight || 800,
      });
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hasAutoFittedRef = useRef(false);
  const prevLayoutModeRef = useRef(layoutMode);
  const prevNodeCountRef = useRef(nodes.length);
  const prevRightPanelRef = useRef(hasRightPanel);
  useEffect(() => {
    if (!hasAutoFittedRef.current && viewportSize.width > 100) {
      hasAutoFittedRef.current = true;
      prevNodeCountRef.current = nodes.length;
      prevRightPanelRef.current = hasRightPanel;
      recenterToFit(false);
      return;
    }
    if (
      prevLayoutModeRef.current !== layoutMode ||
      prevNodeCountRef.current !== nodes.length ||
      prevRightPanelRef.current !== hasRightPanel
    ) {
      prevLayoutModeRef.current = layoutMode;
      prevNodeCountRef.current = nodes.length;
      prevRightPanelRef.current = hasRightPanel;
      recenterToFit(false);
    }
  }, [viewportSize.width, layoutMode, nodes.length, hasRightPanel, recenterToFit]);

  const interactionRef = useRef<{
    mode: "idle" | "pan" | "node";
    nodeUuid?: string;
    startClientX: number;
    startClientY: number;
    startPanX: number;
    startPanY: number;
    startNodePos?: Point2D;
    moved: boolean;
  }>({
    mode: "idle",
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
    moved: false,
  });

  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    cancelCameraAnim2D();
    interactionRef.current = {
      mode: "pan",
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: cameraRef.current.panX,
      startPanY: cameraRef.current.panY,
      moved: false,
    };
  };

  const handleNodePointerDown = (e: React.PointerEvent<SVGGElement>, node: ETGNode) => {
    e.stopPropagation();
    const pos = positions.get(node.uuid) ?? { x: 0, y: 0 };
    interactionRef.current = {
      mode: "node",
      nodeUuid: node.uuid,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: cameraRef.current.panX,
      startPanY: cameraRef.current.panY,
      startNodePos: { ...pos },
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (connectSourceUuid && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const cam = cameraRef.current;
      const worldX = (e.clientX - rect.left - rect.width / 2 - cam.panX) / cam.zoom;
      const worldY = (e.clientY - rect.top - rect.height / 2 - cam.panY) / cam.zoom;
      setPointerWorldPos({ x: worldX, y: worldY });
    }

    const st = interactionRef.current;
    if (st.mode === "idle") return;

    const dx = e.clientX - st.startClientX;
    const dy = e.clientY - st.startClientY;
    if (Math.hypot(dx, dy) > 8) st.moved = true;

    if (st.mode === "pan") {
      setCamera((prev) => ({
        ...prev,
        panX: st.startPanX + dx,
        panY: st.startPanY + dy,
      }));
    } else if (st.mode === "node" && st.nodeUuid && st.startNodePos) {
      const z = cameraRef.current.zoom;
      setDragOverrides((prev) => {
        const next = new Map(prev);
        next.set(st.nodeUuid!, {
          x: st.startNodePos!.x + dx / z,
          y: st.startNodePos!.y + dy / z,
        });
        return next;
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const st = interactionRef.current;
    if (st.mode === "pan" && !st.moved && e.target === svgRef.current) {
      onClearSelection?.();
    }
    interactionRef.current.mode = "idle";
  };

  const handleSvgPointerLeave = (e: React.PointerEvent<SVGSVGElement>) => {
    setPointerWorldPos(null);
    handlePointerUp(e);
  };

  const handleWheelRef = useRef<(e: WheelEvent) => void>(() => {});
  handleWheelRef.current = (e: WheelEvent) => {
    e.preventDefault();
    cancelCameraAnim2D();
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cursorX = e.clientX - rect.left - rect.width / 2;
    const cursorY = e.clientY - rect.top - rect.height / 2;

    setCamera((prev) => {
      const nextZoom = wheelZoomStep(prev.zoom, e.deltaY);
      const scale = nextZoom / prev.zoom;
      return {
        zoom: nextZoom,
        panX: cursorX - (cursorX - prev.panX) * scale,
        panY: cursorY - (cursorY - prev.panY) * scale,
      };
    });
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onSvgWheel = (e: WheelEvent) => handleWheelRef.current(e);
    el.addEventListener("wheel", onSvgWheel, { passive: false });
    return () => el.removeEventListener("wheel", onSvgWheel);
  }, []);

  const zoomAtCenter = useCallback(
    (factor: number) => {
      cancelCameraAnim2D();
      setCamera((prev) => {
        const nextZoom = Math.max(1e-5, Math.min(MAX_ZOOM, prev.zoom * factor));
        const scale = nextZoom / prev.zoom;
        return {
          zoom: nextZoom,
          panX: prev.panX * scale,
          panY: prev.panY * scale,
        };
      });
    },
    [cancelCameraAnim2D]
  );

  const handleNodeInteractionClick = (e: React.MouseEvent<SVGGElement>, node: ETGNode) => {
    e.stopPropagation();
    if (interactionRef.current.moved) return;
    dispatchNodeSelectOrQuickConnect({
      clickedNode: node,
      connectMode,
      shiftKey: e.shiftKey,
      connectSourceUuid,
      selectedNodeUuid,
      lookupNode: (uuid) => nodeById2D.get(uuid),
      onStartQuickConnect,
      onSelectNode,
    });
  };

  const detailTier = resolveDetailTier(camera.zoom);
  const activeFocusUuid = hoveredNodeUuid ?? selectedNodeUuid;
  const activeNeighbors = activeFocusUuid ? neighborMap.get(activeFocusUuid) ?? null : null;
  const hasSearch = matchingUuids.size > 0;

  const dotSpacing = Math.max(16, Math.min(44, 28 * camera.zoom));
  const dotOffsetX = ((viewportSize.width / 2 + camera.panX) % dotSpacing + dotSpacing) % dotSpacing;
  const dotOffsetY = ((viewportSize.height / 2 + camera.panY) % dotSpacing + dotSpacing) % dotSpacing;

  const cardBg = isLightTheme ? "#ffffff" : "#12151f";
  const cardBorder = isLightTheme ? "#d4d4d8" : "rgba(255,255,255,0.12)";
  const cardTitle = isLightTheme ? "#18181b" : "#f4f4f5";
  const connectSourcePos = connectSourceUuid ? positions.get(connectSourceUuid) ?? null : null;
  const dotScale2D = 1 / Math.max(0.4, Math.min(1, camera.zoom));

  const computeEdgeEndpoints2D = (
    p1: Point2D,
    p2: Point2D,
    ctrl: Point2D,
    sourceUuid: string,
    targetUuid: string
  ): { startPt: Point2D; endPt: Point2D } => {
    if (detailTier === "dots") {
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.hypot(dx, dy) || 1;
      const rSrc = computeDotRadius2D(nodeById2D.get(sourceUuid), dotScale2D) + 2;
      const rTgt = computeDotRadius2D(nodeById2D.get(targetUuid), dotScale2D) + 2;
      const trimRadial = (p: Point2D, dirX: number, dirY: number, r: number): Point2D =>
        dist > r * 1.4 ? { x: p.x + dirX * r, y: p.y + dirY * r } : p;
      return {
        startPt: trimRadial(p1, dx / dist, dy / dist, rSrc),
        endPt: trimRadial(p2, -dx / dist, -dy / dist, rTgt),
      };
    }
    const halfW = CARD_WIDTH / 2 + 2;
    const halfH = CARD_HEIGHT / 2 + 2;
    return {
      startPt: intersectBoxBorder(p1, ctrl, halfW, halfH),
      endPt: intersectBoxBorder(p2, ctrl, halfW, halfH),
    };
  };

  // Keep 2D graph uncluttered: hide always-on region headers and dot labels (labels appear on hover, selection, or search)
  const placedRegionHeaders2D: Array<{
    cluster: (typeof regionClusters2D)[number];
    labelText: string;
    pillW: number;
    x: number;
    y: number;
    pillScale: number;
  }> = [];

  const placedDotLabelUuids2D = new Set<string>();
  if (detailTier === "dots") {
    const dotCandidates: ScreenLabelCandidate[] = [];
    for (const node of nodes) {
      const p = positions.get(node.uuid);
      if (!p) continue;
      const sx = viewportSize.width / 2 + camera.panX + p.x * camera.zoom;
      const sy = viewportSize.height / 2 + camera.panY + p.y * camera.zoom;
      if (sx < 40 || sx > viewportSize.width - 40 || sy < 40 || sy > viewportSize.height - 40) {
        continue;
      }
      const deg = neighborMap.get(node.uuid)?.size ?? 0;
      const clean = humanizeNodeText(node.properties.name);
      const shortTitle = clean.length > 44 ? `${clean.slice(0, 42)}…` : clean;
      let priority = deg * 16;
      if (node.label === "Insight") priority += 300;
      if (dipoleNodeUuids2D.has(node.uuid)) priority += 90;
      if (node.uuid === selectedNodeUuid) priority += 1000;
      if (node.uuid === hoveredNodeUuid) priority += 800;
      if (matchingUuids.has(node.uuid)) priority += 450;
      dotCandidates.push({
        uuid: node.uuid,
        title: shortTitle,
        label: node.label,
        color: resolveEtgNodeColor(node),
        x: sx,
        y: sy,
        priority,
        boxHeightPx: 26,
        maxWidthPx: 250,
      });
    }
    for (const placed of selectNonOverlappingLabels(dotCandidates, 14, 14, 10)) {
      placedDotLabelUuids2D.add(placed.uuid);
    }
  }

  const nodeAvoidBoxes2D = nodes
    .map((node) => {
      const p = positions.get(node.uuid);
      if (!p) return null;
      const r = computeDotRadius2D(node, dotScale2D);
      return {
        x: p.x,
        y: p.y,
        halfW: detailTier === "dots" ? r + 6 : CARD_WIDTH / 2,
        halfH: detailTier === "dots" ? r + 6 : CARD_HEIGHT / 2,
      };
    })
    .filter((b): b is { x: number; y: number; halfW: number; halfH: number } => b !== null);

  const preparedEdges2D: PreparedEdge2D[] = [];
  const edgePillCandidates2D: ScreenEdgePillCandidate[] = [];

  edges.forEach((edge, idx) => {
    const p1 = positions.get(edge.source_uuid);
    const p2 = positions.get(edge.target_uuid);
    if (!p1 || !p2) return;

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = -dy / dist;
    const ny = dx / dist;
    const bend = (idx % 2 === 0 ? 1 : -1) * Math.min(42, dist * 0.14);
    const cx = (p1.x + p2.x) / 2 + nx * bend;
    const cy = (p1.y + p2.y) / 2 + ny * bend;

    const { startPt, endPt } = computeEdgeEndpoints2D(
      p1,
      p2,
      { x: cx, y: cy },
      edge.source_uuid,
      edge.target_uuid
    );

    const isEdgeHovered = hoveredEdgeUuid === edge.properties.uuid;
    const isEdgeSelected = selectedEdgeUuid === edge.properties.uuid;
    const isCascadeEdge = cascadeEdgeSet.has(edge.properties.uuid);
    const isConnectedToFocus =
      activeFocusUuid !== null &&
      (edge.source_uuid === activeFocusUuid || edge.target_uuid === activeFocusUuid);
    const matchesSearch =
      hasSearch &&
      (matchingUuids.has(edge.source_uuid) || matchingUuids.has(edge.target_uuid));
    const hasEdgeOrCascadeFocus = selectedEdgeUuid !== null || cascadeEdgeSet.size > 0;
    const isOpposite = edge.type === "drives_opposite";
    const isSupersedes = edge.type === "supersedes";

    let opacity = isLightTheme ? 0.74 : 0.5;
    let strokeWidth = isOpposite ? 2.0 : isSupersedes ? 1.55 : 1.35;
    if (isEdgeHovered || isEdgeSelected || isCascadeEdge || isConnectedToFocus) {
      opacity = 0.96;
      strokeWidth = isEdgeSelected ? 2.8 : isCascadeEdge ? 2.4 : isOpposite ? 2.35 : 2.15;
    } else if (activeFocusUuid || hasSearch) {
      opacity = matchesSearch ? 0.78 : isLightTheme ? 0.22 : 0.12;
    } else if (hasEdgeOrCascadeFocus) {
      opacity = isLightTheme ? 0.24 : 0.14;
    } else if (regionSpotlight) {
      if (regionSpotlight.spotlightEdgeSet.has(edge.properties.uuid)) {
        opacity = isLightTheme ? 0.88 : 0.82;
        strokeWidth += 0.35;
      } else {
        opacity = isLightTheme ? 0.12 : 0.07;
      }
    }

    const rawStrokeColor = resolveEtgEdgeColor(edge.type);
    const baseStrokeColor =
      isLightTheme && rawStrokeColor.toLowerCase() === "#94a3b8"
        ? "#52525b"
        : isLightTheme && isOpposite
          ? "#e11d48"
          : isLightTheme && isSupersedes
            ? "#9333ea"
            : rawStrokeColor;
    const strokeColor = isEdgeSelected
      ? isLightTheme
        ? "#b45309"
        : "#fef08a"
      : isCascadeEdge
        ? isLightTheme
          ? "#d97706"
          : "#fbbf24"
        : baseStrokeColor;

    const midLabelX = 0.25 * startPt.x + 0.5 * cx + 0.25 * endPt.x;
    const midLabelY = 0.25 * startPt.y + 0.5 * cy + 0.25 * endPt.y;
    const relationPrefix = isOpposite ? "⇄ " : isSupersedes ? "↻ " : "";
    const relationLabel = `${relationPrefix}${formatEdgeRelationLabel(edge.type, edge.properties.custom_label)}`;
    const lagSuffix =
      typeof edge.properties.optimal_lag_steps === "number" &&
      edge.properties.optimal_lag_steps > 0
        ? ` · Δt=${edge.properties.optimal_lag_steps}${edge.properties.lag_unit?.[0] ?? ""}`
        : "";
    const corrSuffix =
      edge.properties.correlation_r !== undefined
        ? ` · r=${edge.properties.correlation_r.toFixed(2)}`
        : "";
    const pillLabel = `${relationLabel}${lagSuffix}${corrSuffix}`;
    const showPillCandidate =
      isEdgeHovered ||
      isEdgeSelected ||
      isCascadeEdge ||
      isConnectedToFocus ||
      (nodes.length <= 28 && !activeFocusUuid && (isOpposite || isSupersedes));
    const pillPriority = isEdgeSelected
      ? 1000
      : isEdgeHovered
        ? 900
        : isCascadeEdge
          ? 700
          : isOpposite
            ? 450
            : isSupersedes
              ? 380
              : 240;

    const markerEndId = isEdgeSelected || isCascadeEdge
      ? "url(#etg-arrow-selected)"
      : isOpposite
        ? "url(#etg-arrow-opposite)"
        : isSupersedes
          ? "url(#etg-arrow-supersedes)"
          : "url(#etg-arrow-causal)";
    const markerStartId = isOpposite ? "url(#etg-dot-opposite)" : undefined;

    preparedEdges2D.push({
      edge,
      edgePath: `M ${startPt.x} ${startPt.y} Q ${cx} ${cy} ${endPt.x} ${endPt.y}`,
      strokeColor,
      strokeWidth,
      opacity,
      isOpposite,
      isSupersedes,
      markerEndId,
      markerStartId,
      pillX: midLabelX,
      pillY: midLabelY,
      pillLabel,
    });

    if (showPillCandidate) {
      edgePillCandidates2D.push({
        uuid: edge.properties.uuid,
        x: midLabelX,
        y: midLabelY,
        label: pillLabel,
        priority: pillPriority,
      });
    }
  });

  const placedEdgePillIds2D = new Set(
    selectNonOverlappingEdgePills(edgePillCandidates2D, nodeAvoidBoxes2D, 14, 10, 6).map(
      (p) => p.uuid
    )
  );

  return (
    <div className="etg-graph-void relative h-full w-full overflow-hidden select-none">
      <svg
        ref={svgRef}
        className={`h-full w-full ${connectMode ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
        onPointerDown={handleSvgPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handleSvgPointerLeave}
        aria-label="2D Earth Trend Knowledge Graph"
      >
        <Graph2DSvgDefs
          dotOffsetX={dotOffsetX}
          dotOffsetY={dotOffsetY}
          dotSpacing={dotSpacing}
          isLightTheme={isLightTheme}
        />

        {/* Dot-matrix canvas background */}
        <rect width="100%" height="100%" fill="url(#etg-dot-grid)" pointerEvents="none" />

        {/* World transform group */}
        <g
          transform={`translate(${viewportSize.width / 2 + camera.panX}, ${
            viewportSize.height / 2 + camera.panY
          }) scale(${camera.zoom})`}
        >
          {/* Regional area headers (de-overlapped & clickable to pan/zoom to region) */}
          {placedRegionHeaders2D.map(({ cluster, labelText, pillW, x, y, pillScale }) => {
            const isFocused = selectedRegionScope === cluster.id;
            return (
              <g
                key={`reg2d-${cluster.id}`}
                transform={`translate(${x}, ${y}) scale(${pillScale})`}
                className="cursor-pointer"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  panToRegion2D(cluster.id);
                  onChangeRegionScope?.(cluster.id);
                }}
              >
                <title>{cluster.label}</title>
                <rect
                  x={-pillW / 2}
                  y={-12}
                  width={pillW}
                  height={24}
                  rx={12}
                  fill={
                    isFocused
                      ? isLightTheme
                        ? "#fef3c7"
                        : "#451a03"
                      : isLightTheme
                        ? "rgba(255,255,255,0.92)"
                        : "rgba(15,19,29,0.9)"
                  }
                  stroke={
                    isFocused
                      ? isLightTheme
                        ? "#d97706"
                        : "#fbbf24"
                      : isLightTheme
                        ? "#d4d4d8"
                        : "rgba(255,255,255,0.16)"
                  }
                  strokeWidth={1}
                />
                <circle
                  cx={-pillW / 2 + 12}
                  cy={0}
                  r={3}
                  fill={isLightTheme ? "#d97706" : "#fbbf24"}
                />
                <text
                  x={5}
                  y={0}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={9.5}
                  fontWeight={700}
                  letterSpacing="0.06em"
                  fill={
                    isFocused
                      ? isLightTheme
                        ? "#92400e"
                        : "#fde68a"
                      : isLightTheme
                        ? "#27272a"
                        : "#e4e4e7"
                  }
                >
                  {labelText}
                </text>
              </g>
            );
          })}

          {/* Curved Bezier edges with directional arrows & dipole emphasis */}
          {preparedEdges2D.map((item) => (
            <g
              key={item.edge.properties.uuid}
              className="cursor-pointer"
              onPointerEnter={() => setHoveredEdgeUuid(item.edge.properties.uuid)}
              onPointerLeave={() => setHoveredEdgeUuid(null)}
              onClick={(e) => {
                e.stopPropagation();
                onSelectEdge?.(item.edge);
              }}
            >
              <path
                d={item.edgePath}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                vectorEffect="non-scaling-stroke"
              />
              {item.isOpposite && (
                <path
                  d={item.edgePath}
                  fill="none"
                  stroke={isLightTheme ? "#fda4af" : "#fb7185"}
                  strokeWidth={item.strokeWidth + 4}
                  strokeOpacity={Math.min(0.28, item.opacity * 0.25)}
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
              )}
              <path
                d={item.edgePath}
                fill="none"
                stroke={item.strokeColor}
                strokeWidth={item.strokeWidth}
                strokeDasharray={
                  item.isSupersedes || item.edge.type === "hypothesized_link"
                    ? "5 4"
                    : undefined
                }
                strokeOpacity={item.opacity}
                markerStart={item.markerStartId}
                markerEnd={item.markerEndId}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}

          {/* De-overlapped edge midpoint relationship pills rendered cleanly above edges */}
          {preparedEdges2D.map((item) => {
            if (!placedEdgePillIds2D.has(item.edge.properties.uuid)) return null;
            return (
              <g
                key={`pill-${item.edge.properties.uuid}`}
                transform={`translate(${item.pillX}, ${item.pillY})`}
                pointerEvents="none"
              >
                <rect
                  x={-(item.pillLabel.length * 3.2 + 12)}
                  y={-11}
                  width={item.pillLabel.length * 6.4 + 24}
                  height={22}
                  rx={5}
                  fill={isLightTheme ? "#ffffff" : "#11141d"}
                  stroke={item.strokeColor}
                  strokeWidth={1}
                />
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={9.5}
                  fontWeight={600}
                  letterSpacing="0.05em"
                  fill={item.strokeColor}
                >
                  {item.pillLabel}
                </text>
              </g>
            );
          })}

          {/* Candidate latent links (dashed violet click-to-wire suggestions) */}
          {candidateLinks.map((suggestion, idx) => {
            const p1 = positions.get(suggestion.sourceUuid);
            const p2 = positions.get(suggestion.targetUuid);
            if (!p1 || !p2) return null;

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const dist = Math.hypot(dx, dy) || 1;
            const nx = -dy / dist;
            const ny = dx / dist;
            const bend = (idx % 2 === 0 ? -1 : 1) * Math.min(48, dist * 0.16);
            const cx = (p1.x + p2.x) / 2 + nx * bend;
            const cy = (p1.y + p2.y) / 2 + ny * bend;

            const { startPt, endPt } = computeEdgeEndpoints2D(
              p1,
              p2,
              { x: cx, y: cy },
              suggestion.sourceUuid,
              suggestion.targetUuid
            );
            const midX = 0.25 * startPt.x + 0.5 * cx + 0.25 * endPt.x;
            const midY = 0.25 * startPt.y + 0.5 * cy + 0.25 * endPt.y;
            const lagVal = suggestion.optimalLagSteps ?? 0;
            const statPart =
              suggestion.pearsonR !== undefined
                ? `r=${suggestion.pearsonR.toFixed(2)}`
                : `${Math.round(suggestion.score * 100)}%`;
            const ghostLabel =
              lagVal > 0
                ? `+ Wire · Δt=${lagVal}${suggestion.lagUnit?.[0] ?? ""} · ${statPart}`
                : `+ Wire · ${statPart}`;
            const ghostPath = `M ${startPt.x} ${startPt.y} Q ${cx} ${cy} ${endPt.x} ${endPt.y}`;

            return (
              <g
                key={`cand-${suggestion.sourceUuid}-${suggestion.targetUuid}`}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onAcceptCandidateLink?.(suggestion);
                }}
              >
                <path
                  d={ghostPath}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={ghostPath}
                  fill="none"
                  stroke="#a78bfa"
                  strokeWidth={1.8}
                  strokeDasharray="6 5"
                  strokeOpacity={0.82}
                  vectorEffect="non-scaling-stroke"
                />
                <g transform={`translate(${midX}, ${midY})`}>
                  <rect
                    x={-(ghostLabel.length * 3.2 + 12)}
                    y={-11}
                    width={ghostLabel.length * 6.4 + 24}
                    height={22}
                    rx={5}
                    fill={isLightTheme ? "#f5f3ff" : "#1b1630"}
                    stroke="#a78bfa"
                    strokeWidth={1.1}
                  />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={9.5}
                    fontWeight={600}
                    fill={isLightTheme ? "#5b21b6" : "#ddd6fe"}
                  >
                    {ghostLabel}
                  </text>
                </g>
              </g>
            );
          })}

          {/* Active rubber-band link preview during Connect Mode */}
          {connectSourcePos && pointerWorldPos && (
            <line
              x1={connectSourcePos.x}
              y1={connectSourcePos.y}
              x2={pointerWorldPos.x}
              y2={pointerWorldPos.y}
              stroke="#fbbf24"
              strokeWidth={2}
              strokeDasharray="6 4"
              strokeOpacity={0.88}
              pointerEvents="none"
            />
          )}

          {/* Nodes (Dots vs 248x64 Rich Scientific Cards) */}
          {nodes.map((node) => {
            const p = positions.get(node.uuid);
            if (!p) return null;

            const isSelected = node.uuid === selectedNodeUuid;
            const isHovered = node.uuid === hoveredNodeUuid;
            const isConnectSource = connectSourceUuid === node.uuid;
            const isNeighbor = activeNeighbors ? activeNeighbors.has(node.uuid) : false;
            const isSearchHit = matchingUuids.has(node.uuid);

            let nodeOpacity = 1;
            if (hasSearch) {
              nodeOpacity = isSearchHit ? 1 : 0.22;
            } else if (activeFocusUuid) {
              nodeOpacity = isSelected || isHovered || isNeighbor || isConnectSource ? 1 : 0.28;
            } else if (regionSpotlight) {
              nodeOpacity = regionSpotlight.localNodeSet.has(node.uuid)
                ? 1
                : regionSpotlight.bridgeNodeSet.has(node.uuid)
                  ? 0.88
                  : 0.2;
            }

            return (
              <Graph2DNodeItem
                key={node.uuid}
                node={node}
                position={p}
                detailTier={detailTier}
                dotScale2D={dotScale2D}
                nodeOpacity={nodeOpacity}
                isSelected={isSelected}
                isHovered={isHovered}
                isConnectSource={isConnectSource}
                isSearchHit={isSearchHit}
                showDotLabel={placedDotLabelUuids2D.has(node.uuid)}
                isLightTheme={isLightTheme}
                connectMode={connectMode}
                cardBg={cardBg}
                cardBorder={cardBorder}
                cardTitle={cardTitle}
                role={roleByNode[node.uuid]}
                hop={hopByNode[node.uuid]}
                microscopeCue={microscopeByNode[node.uuid]}
                hasQuickConnect={Boolean(onStartQuickConnect)}
                onPointerDown={handleNodePointerDown}
                onHoverChange={setHoveredNodeUuid}
                onNodeClick={handleNodeInteractionClick}
                onQuickConnectPortClick={(clickedNode) =>
                  dispatchNodeSelectOrQuickConnect({
                    clickedNode,
                    connectMode: true,
                    shiftKey: false,
                    connectSourceUuid,
                    selectedNodeUuid,
                    lookupNode: (uuid) => nodeById2D.get(uuid),
                    onStartQuickConnect,
                    onSelectNode,
                  })
                }
              />
            );
          })}
        </g>
      </svg>

      {/* Bottom-left Minimap + Camera Dock */}
      <div className="absolute bottom-2.5 left-2.5 z-10 flex flex-col items-start gap-2">
        <Graph2DMinimap
          nodes={nodes}
          positions={positions}
          bounds={bounds}
          camera={camera}
          viewportSize={viewportSize}
          selectedNodeUuid={selectedNodeUuid}
          onPanToWorld={(worldX, worldY) => {
            cancelCameraAnim2D();
            setCamera((prev) => ({
              ...prev,
              panX: -worldX * prev.zoom,
              panY: -worldY * prev.zoom,
            }));
          }}
        />

        <GraphCameraDock
          showOrbitControls={false}
          onRecenter={() => recenterToFit(true)}
          onZoomIn={() => zoomAtCenter(1.25)}
          onZoomOut={() => zoomAtCenter(0.8)}
        />
      </div>
    </div>
  );
}
