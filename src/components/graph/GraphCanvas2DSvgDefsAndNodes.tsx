"use client";

import type React from "react";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  type DetailTier,
  type Point2D,
  resolveEtgNodeColor,
} from "@/lib/graph/graphVisuals";
import { humanizeNodeText } from "@/lib/plainLanguage";
import type {
  ETGNode,
  NodeTrendMicroscopeCue,
  SubgraphNodeRole,
} from "@/types/etg";
import { resolveMicroscopeNodeBadge } from "@/components/graph/graphViewShared";

export function computeDotRadius2D(node: ETGNode | undefined, dotScale2D: number): number {
  const baseR =
    node?.label === "Insight"
      ? 13
      : node?.label === "Concept"
        ? 11
        : node?.label === "Rule"
          ? 10
          : 8.5;
  return baseR * Math.min(2.1, dotScale2D);
}

/** SVG grid pattern, card label clip paths, and directional/dipole arrow markers for 2D ETG view. */
export function Graph2DSvgDefs({
  dotOffsetX,
  dotOffsetY,
  dotSpacing,
  isLightTheme,
}: {
  dotOffsetX: number;
  dotOffsetY: number;
  dotSpacing: number;
  isLightTheme: boolean;
}) {
  return (
    <defs>
      <pattern
        id="etg-dot-grid"
        x={dotOffsetX}
        y={dotOffsetY}
        width={dotSpacing}
        height={dotSpacing}
        patternUnits="userSpaceOnUse"
      >
        <circle
          cx={1}
          cy={1}
          r={1}
          fill={isLightTheme ? "rgba(24, 24, 27, 0.14)" : "rgba(255, 255, 255, 0.12)"}
        />
      </pattern>
      <clipPath id="etg-card-clip-full">
        <rect
          x={-CARD_WIDTH / 2 + 24}
          y={-CARD_HEIGHT / 2}
          width={CARD_WIDTH - 36}
          height={CARD_HEIGHT}
        />
      </clipPath>
      <clipPath id="etg-card-clip-badged">
        <rect
          x={-CARD_WIDTH / 2 + 24}
          y={-CARD_HEIGHT / 2}
          width={CARD_WIDTH - 80}
          height={CARD_HEIGHT}
        />
      </clipPath>
      <clipPath id="etg-card-clip-double">
        <rect
          x={-CARD_WIDTH / 2 + 24}
          y={-CARD_HEIGHT / 2}
          width={CARD_WIDTH - 128}
          height={CARD_HEIGHT}
        />
      </clipPath>
      <marker
        id="etg-arrow-causal"
        viewBox="0 0 10 10"
        refX="8.5"
        refY="5"
        markerWidth="6.5"
        markerHeight="6.5"
        orient="auto"
      >
        <path
          d="M 1.5 1.8 L 8.5 5 L 1.5 8.2 z"
          fill={isLightTheme ? "#52525b" : "#94a3b8"}
          opacity="0.85"
        />
      </marker>
      <marker
        id="etg-arrow-opposite"
        viewBox="0 0 10 10"
        refX="8.5"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto"
      >
        <path
          d="M 1.2 1.5 L 8.8 5 L 1.2 8.5 z"
          fill={isLightTheme ? "#e11d48" : "#fb7185"}
        />
      </marker>
      <marker
        id="etg-dot-opposite"
        viewBox="0 0 10 10"
        refX="5"
        refY="5"
        markerWidth="5.5"
        markerHeight="5.5"
      >
        <circle
          cx="5"
          cy="5"
          r="3"
          fill={isLightTheme ? "#ffffff" : "#0b0c10"}
          stroke={isLightTheme ? "#e11d48" : "#fb7185"}
          strokeWidth="2"
        />
      </marker>
      <marker
        id="etg-arrow-supersedes"
        viewBox="0 0 10 10"
        refX="8.5"
        refY="5"
        markerWidth="6.8"
        markerHeight="6.8"
        orient="auto"
      >
        <path
          d="M 1.2 1.8 L 8.5 5 L 1.2 8.2 z"
          fill={isLightTheme ? "#9333ea" : "#c084fc"}
        />
      </marker>
      <marker
        id="etg-arrow-selected"
        viewBox="0 0 10 10"
        refX="8.5"
        refY="5"
        markerWidth="7.5"
        markerHeight="7.5"
        orient="auto"
      >
        <path
          d="M 1.2 1.5 L 8.8 5 L 1.2 8.5 z"
          fill={isLightTheme ? "#b45309" : "#fbbf24"}
        />
      </marker>
    </defs>
  );
}

/** Semantic-zoom 2D node element rendered either as a labeled dot or a 248x64 ETG card. */
export function Graph2DNodeItem({
  node,
  position,
  detailTier,
  dotScale2D,
  nodeOpacity,
  isSelected,
  isHovered,
  isConnectSource,
  isSearchHit,
  showDotLabel,
  isLightTheme,
  connectMode,
  cardBg,
  cardBorder,
  cardTitle,
  role,
  hop,
  microscopeCue,
  hasQuickConnect,
  onPointerDown,
  onHoverChange,
  onNodeClick,
  onQuickConnectPortClick,
}: {
  node: ETGNode;
  position: Point2D;
  detailTier: DetailTier;
  dotScale2D: number;
  nodeOpacity: number;
  isSelected: boolean;
  isHovered: boolean;
  isConnectSource: boolean;
  isSearchHit: boolean;
  showDotLabel: boolean;
  isLightTheme: boolean;
  connectMode: boolean;
  cardBg: string;
  cardBorder: string;
  cardTitle: string;
  role?: SubgraphNodeRole;
  hop?: number;
  microscopeCue?: NodeTrendMicroscopeCue;
  hasQuickConnect: boolean;
  onPointerDown: (e: React.PointerEvent<SVGGElement>, node: ETGNode) => void;
  onHoverChange: (uuid: string | null) => void;
  onNodeClick: (e: React.MouseEvent<SVGGElement>, node: ETGNode) => void;
  onQuickConnectPortClick: (node: ETGNode) => void;
}) {
  const color = resolveEtgNodeColor(node);

  if (detailTier === "dots") {
    const r = computeDotRadius2D(node, dotScale2D);
    const isSupersededDot =
      node.properties.status === "Superseded" || Boolean(node.properties.superseded_by);
    const clean = humanizeNodeText(node.properties.name);
    const shortLabel = clean.length > 28 ? `${clean.slice(0, 26)}…` : clean;
    const effectiveShow = isSelected || isHovered || isSearchHit || showDotLabel;

    return (
      <g
        data-node-uuid={node.uuid}
        transform={`translate(${position.x}, ${position.y})`}
        opacity={isSupersededDot && !isSelected && !isHovered ? nodeOpacity * 0.68 : nodeOpacity}
        className="cursor-pointer"
        onPointerDown={(e) => onPointerDown(e, node)}
        onPointerEnter={() => onHoverChange(node.uuid)}
        onPointerLeave={() => onHoverChange(null)}
        onClick={(e) => onNodeClick(e, node)}
      >
        {isConnectSource && (
          <circle
            r={r + 5 * Math.min(2, dotScale2D)}
            fill="none"
            stroke="#fbbf24"
            strokeWidth={2 * Math.min(2, dotScale2D)}
            strokeDasharray="4 3"
            strokeOpacity={0.75}
          />
        )}
        <circle
          r={r}
          fill={color}
          stroke={isLightTheme ? "#ffffff" : "#0b0c10"}
          strokeDasharray={isSupersededDot ? "3 2" : undefined}
          strokeWidth={1.8 * Math.min(2, dotScale2D)}
        />
        {effectiveShow && (
          <text
            y={r + 14 * Math.min(2, dotScale2D)}
            textAnchor="middle"
            fontSize={10.5 * Math.min(2, dotScale2D)}
            fontWeight={500}
            fill={cardTitle}
          >
            {shortLabel}
          </text>
        )}
      </g>
    );
  }

  const isSuperseded =
    node.properties.status === "Superseded" || Boolean(node.properties.superseded_by);
  const microBadge = resolveMicroscopeNodeBadge(microscopeCue, isLightTheme);
  const roleBadge =
    role === "root"
      ? {
          text: "ROOT",
          bg: isLightTheme ? "#fef3c7" : "#382810",
          fg: isLightTheme ? "#92400e" : "#e2a856",
        }
      : role === "upstream"
        ? {
            text: `DRV ${hop ?? 1}h`,
            bg: isLightTheme ? "#e0f2fe" : "#082f49",
            fg: isLightTheme ? "#075985" : "#38bdf8",
          }
        : role === "downstream"
          ? {
              text: `IMP ${hop ?? 1}h`,
              bg: isLightTheme ? "#ffedd5" : "#451a03",
              fg: isLightTheme ? "#9a3412" : "#fb923c",
            }
          : null;

  const statusOrMicroBadge = isSuperseded
    ? {
        text: "OLD",
        bg: isLightTheme ? "#f4f4f5" : "#27272a",
        fg: isLightTheme ? "#52525b" : "#a1a1aa",
      }
    : microBadge
      ? {
          text: microBadge.text,
          bg: microBadge.bg,
          fg: microBadge.fg,
        }
      : null;

  const badgeCount = (roleBadge ? 1 : 0) + (statusOrMicroBadge ? 1 : 0);
  const cleanName = humanizeNodeText(node.properties.name);
  const maxChars = badgeCount === 2 ? 14 : badgeCount === 1 ? 20 : 28;
  let titleText = cleanName;
  if (cleanName.length > maxChars) {
    const sliced = cleanName.slice(0, maxChars);
    const lastSpace = sliced.lastIndexOf(" ");
    const cutoff = lastSpace >= Math.floor(maxChars * 0.55) ? lastSpace : maxChars - 1;
    titleText = `${cleanName.slice(0, cutoff).trimEnd()}…`;
  }

  return (
    <g
      data-node-uuid={node.uuid}
      transform={`translate(${position.x}, ${position.y})`}
      opacity={isSuperseded && !isSelected && !isHovered ? nodeOpacity * 0.72 : nodeOpacity}
      className="cursor-pointer"
      onPointerDown={(e) => onPointerDown(e, node)}
      onPointerEnter={() => onHoverChange(node.uuid)}
      onPointerLeave={() => onHoverChange(null)}
      onClick={(e) => onNodeClick(e, node)}
    >
      {/* Dashed ring for active Connect source */}
      {isConnectSource && (
        <rect
          x={-CARD_WIDTH / 2 - 3.5}
          y={-CARD_HEIGHT / 2 - 3.5}
          width={CARD_WIDTH + 7}
          height={CARD_HEIGHT + 7}
          rx={10}
          fill="none"
          stroke="#fbbf24"
          strokeDasharray="5 3"
          strokeOpacity={0.85}
          strokeWidth={1.75}
        />
      )}

      {/* Single-row card: ontology dot + node name */}
      <rect
        x={-CARD_WIDTH / 2}
        y={-CARD_HEIGHT / 2}
        width={CARD_WIDTH}
        height={CARD_HEIGHT}
        rx={8}
        fill={cardBg}
        stroke={isConnectSource ? "#fbbf24" : isSelected || isHovered ? color : cardBorder}
        strokeDasharray={isSuperseded ? "5 3" : undefined}
        strokeWidth={isSelected || isConnectSource ? 1.6 : 1}
      />

      <circle cx={-CARD_WIDTH / 2 + 15} cy={0} r={4.5} fill={color} />

      <text
        x={-CARD_WIDTH / 2 + 27}
        y={0}
        dominantBaseline="central"
        fontSize={12}
        fontWeight={600}
        fill={cardTitle}
        textDecoration={isSuperseded ? "line-through" : undefined}
        clipPath={
          badgeCount === 2
            ? "url(#etg-card-clip-double)"
            : badgeCount === 1
              ? "url(#etg-card-clip-badged)"
              : "url(#etg-card-clip-full)"
        }
      >
        {titleText}
      </text>

      {statusOrMicroBadge && (
        <g transform={`translate(${roleBadge ? CARD_WIDTH / 2 - 98 : CARD_WIDTH / 2 - 52}, 0)`}>
          <rect x={0} y={-8} width={42} height={16} rx={4} fill={statusOrMicroBadge.bg} />
          <text
            x={21}
            y={0}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={7.5}
            fontWeight={700}
            fill={statusOrMicroBadge.fg}
          >
            {statusOrMicroBadge.text}
          </text>
        </g>
      )}

      {roleBadge && (
        <g transform={`translate(${CARD_WIDTH / 2 - 52}, 0)`}>
          <rect x={0} y={-8} width={42} height={16} rx={4} fill={roleBadge.bg} />
          <text
            x={21}
            y={0}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={8}
            fontWeight={700}
            fill={roleBadge.fg}
          >
            {roleBadge.text}
          </text>
        </g>
      )}

      {/* Clickable '+' output link port on right card edge */}
      {hasQuickConnect && (isHovered || isSelected || connectMode || isConnectSource) && (
        <g
          transform={`translate(${CARD_WIDTH / 2}, 0)`}
          className="cursor-crosshair"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onQuickConnectPortClick(node);
          }}
        >
          <title>Start causal link from {node.properties.name}</title>
          <circle
            cx={0}
            cy={0}
            r={8.5}
            fill={isConnectSource ? "#fbbf24" : "#e2a856"}
            stroke={isLightTheme ? "#ffffff" : "#0b0c10"}
            strokeWidth={1.5}
          />
          <text
            x={0}
            y={0.5}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={11}
            fontWeight={700}
            fill="#12141a"
          >
            +
          </text>
        </g>
      )}
    </g>
  );
}

/** Bottom-left overview minimap for the 2D graph canvas with click-to-pan navigation. */
export function Graph2DMinimap({
  nodes,
  positions,
  bounds,
  camera,
  viewportSize,
  selectedNodeUuid,
  onPanToWorld,
}: {
  nodes: ETGNode[];
  positions: Map<string, Point2D>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  camera: { panX: number; panY: number; zoom: number };
  viewportSize: { width: number; height: number };
  selectedNodeUuid: string | null;
  onPanToWorld: (worldX: number, worldY: number) => void;
}) {
  const mapW = 164;
  const mapH = 104;
  const worldW = Math.max(400, bounds.maxX - bounds.minX);
  const worldH = Math.max(300, bounds.maxY - bounds.minY);
  const mapScale = Math.min((mapW - 16) / worldW, (mapH - 16) / worldH);
  const mapCenterX = (bounds.minX + bounds.maxX) / 2;
  const mapCenterY = (bounds.minY + bounds.maxY) / 2;

  const viewWorldX = -camera.panX / camera.zoom;
  const viewWorldY = -camera.panY / camera.zoom;
  const viewWorldW = viewportSize.width / camera.zoom;
  const viewWorldH = viewportSize.height / camera.zoom;

  return (
    <div
      className="etg-hud-pill overflow-hidden rounded-md bg-surface p-1"
      aria-label="2D graph overview minimap"
    >
      <svg
        width={mapW}
        height={mapH}
        className="block cursor-crosshair rounded-sm"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const clickX = e.clientX - rect.left - mapW / 2;
          const clickY = e.clientY - rect.top - mapH / 2;
          onPanToWorld(mapCenterX + clickX / mapScale, mapCenterY + clickY / mapScale);
        }}
      >
        {nodes.map((n) => {
          const p = positions.get(n.uuid);
          if (!p) return null;
          const mx = mapW / 2 + (p.x - mapCenterX) * mapScale;
          const my = mapH / 2 + (p.y - mapCenterY) * mapScale;
          return (
            <circle
              key={n.uuid}
              cx={mx}
              cy={my}
              r={n.uuid === selectedNodeUuid ? 3 : 2}
              fill={resolveEtgNodeColor(n)}
              opacity={n.uuid === selectedNodeUuid ? 1 : 0.72}
            />
          );
        })}

        <rect
          x={mapW / 2 + (viewWorldX - viewWorldW / 2 - mapCenterX) * mapScale}
          y={mapH / 2 + (viewWorldY - viewWorldH / 2 - mapCenterY) * mapScale}
          width={Math.max(12, viewWorldW * mapScale)}
          height={Math.max(10, viewWorldH * mapScale)}
          fill="rgba(226, 168, 86, 0.08)"
          stroke="#e2a856"
          strokeWidth={1}
          rx={2}
        />
      </svg>
    </div>
  );
}
