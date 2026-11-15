import { NextRequest, NextResponse } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import {
  validateAndApplyGraphActionsAsync,
  type AppliedGraphActionResult,
  type ProposedGraphAction,
} from "@/lib/graph/graphGuard";
import { predictFromGraph } from "@/lib/graph/graphPredictor";
import { scanTrendMicroscope } from "@/lib/graph/trendMicroscope";
import { fetchEarthTimeSeries } from "@/lib/nasa/nasaPowerClient";
import { analyzeTimeSeries } from "@/lib/stats/trendEngine";
import type { ETGDatasetId, GraphPredictionResult, TrendAnalysisSummary } from "@/types/etg";

export const dynamic = "force-dynamic";

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

function isShortOrCasualPrompt(q: string): boolean {
  const trimmed = q.trim();
  if (!trimmed) return false;
  if (trimmed.length <= 3 && !/[?\d]/.test(trimmed)) return true;
  return /^(hi|hey|hello|yo|sup|howdy|thanks|thank you|thx|ok|okay|cool|nice|test|ping|help|what can you do\??)$/i.test(
    trimmed
  );
}

function parseLlmJsonResponse(raw: string): {
  briefing: string;
  actions: ProposedGraphAction[];
} {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(candidate) as {
      briefing?: string;
      actions?: ProposedGraphAction[];
    };
    if (typeof parsed.briefing === "string") {
      return {
        briefing: parsed.briefing,
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      };
    }
  } catch {
    // Model returned plain markdown text instead of JSON
  }
  return { briefing: trimmed, actions: [] };
}

function inferDeterministicActionsFromQuestion(
  question: string | undefined,
  candidateLinks: ReturnType<ReturnType<typeof getEtgStore>["discoverCandidateLinks"]>,
  selectedNodeUuid: string | undefined
): ProposedGraphAction[] {
  if (!question) return [];
  const q = question.trim();

  if (
    /\b(clear|wipe|reset|delete\s+all|destroy|corrupt|drop\s+table)\b/i.test(q) ||
    /ignore\s+(all\s+)?(previous|prior)\s+instructions/i.test(q)
  ) {
    return [{ type: "clear_graph", rationale: q }];
  }

  if (/\b(delete|remove)\b/i.test(q) && selectedNodeUuid) {
    return [{ type: "delete_node", uuid: selectedNodeUuid, rationale: q }];
  }

  if (/\b(discover|find)\b.*\b(missing|latent|candidate)?\s*links?\b/i.test(q)) {
    return [{ type: "discover_missing_links", anchorUuid: selectedNodeUuid, limit: 3 }];
  }

  if (/\b(connect|wire|link|apply\s+links?)\b/i.test(q) && candidateLinks.length > 0) {
    return candidateLinks.slice(0, 2).map((c) => ({
      type: "connect_nodes",
      sourceUuid: c.sourceUuid,
      targetUuid: c.targetUuid,
      edgeType: c.suggestedType,
      rationale:
        c.rationale || `Empirically discovered ${c.suggestedType} link (r=${c.pearsonR ?? "N/A"}).`,
    }));
  }

  return [];
}

function buildSystemInstruction(allowEdits: boolean): string {
  const base = [
    "You are the Earth Trend Detective AI inside an interactive NASA & Earth-system Knowledge Graph (ETG) workbench.",
    "PROPORTIONALITY RULE: Match your tone and length to the user's message. If the user sends a typo/fragment (e.g. 'f'), a greeting ('hi'), or a quick question ('how many nodes?'), reply naturally in 1-2 short sentences — NEVER output a multi-paragraph telemetry report unless the user asks for analysis! When asked for scientific trend analysis, cite [uuid]s, Mann-Kendall p-values, and Theil-Sen slopes clearly.",
  ];

  if (!allowEdits) {
    base.push("Keep analytical answers concise and well-structured, citing node UUIDs in brackets.");
    return base.join("\n\n");
  }

  base.push(
    [
      "CORE GRAPH EDITOR RULE: You are also the primary conversational editor for the Earth Trend Knowledge Graph (ETG).",
      "Whenever the user asks to add data/signals for a location (supplying accurate lat/lng coordinates, e.g. Boulder CO = 40.015, -105.2705; Niwot Ridge = 40.055, -105.588; Denver = 39.74, -104.99), create Concept/Signal/Insight/Rule nodes, connect nodes, update metadata, revise conclusions via supersedes, or discover missing links, emit those objects in \"actions\".",
      "You may reference nodes created earlier in the same \"actions\" array as \"$0\", \"$1\", etc. Never propose mass deletions or unscientific edits.",
      "Respond ONLY with valid JSON matching: {\"briefing\": \"<natural response matching prompt scale>\", \"actions\": [...]}. Leave \"actions\": [] for greetings, fragments, or pure Q&A.",
      "Supported action objects:",
      "- {\"type\":\"ingest_live_signal\",\"name\":\"...\",\"region\":\"...\",\"lat\":40.015,\"lng\":-105.2705,\"dataset\":\"nasa_power|wildfire|ocean_temp|air_quality|deforestation|hydrology\",\"connectToUuid\":\"optional-uuid|$0\",\"edgeType\":\"drives_opposite|teleconnects|corroborates|correlates_with|triggers|impacts|supports|amplifies|dampens|relates_to\",\"rationale\":\"...\"}",
      "- {\"type\":\"create_node\",\"label\":\"Concept|Signal|Insight|Rule\",\"name\":\"...\",\"description\":\"...\",\"region\":\"...\",\"lat\":40.0,\"lng\":-105.2,\"dataset\":\"optional\",\"relatedNodeUuids\":[\"...\"],\"rationale\":\"...\"}",
      "- {\"type\":\"create_insight\",\"name\":\"...\",\"description\":\"...\",\"region\":\"...\",\"relatedNodeUuids\":[\"...\"],\"rationale\":\"...\"}",
      "- {\"type\":\"connect_nodes\",\"sourceUuid\":\"...|$0\",\"targetUuid\":\"...|$1\",\"edgeType\":\"drives_opposite|teleconnects|corroborates|correlates_with|triggers|impacts|supports|amplifies|dampens|relates_to\",\"rationale\":\"...\"}",
      "- {\"type\":\"update_node\",\"uuid\":\"...\",\"name\":\"optional\",\"description\":\"optional\",\"region\":\"optional\",\"rationale\":\"...\"}",
      "- {\"type\":\"revise_belief\",\"priorNodeUuid\":\"...\",\"newName\":\"...\",\"newDescription\":\"...\",\"rationale\":\"...\"}",
      "- {\"type\":\"discover_missing_links\",\"anchorUuid\":\"optional-uuid\",\"limit\":3}",
    ].join("\n")
  );

  return base.join("\n\n");
}

function collectCitedNodes(
  applied: AppliedGraphActionResult[],
  selectedNodeUuid: string | undefined,
  oppositePairs: ReturnType<ReturnType<typeof getEtgStore>["getSnapshot"]>["oppositeTrendPairs"]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (uuid: string | undefined) => {
    if (uuid && !seen.has(uuid)) {
      seen.add(uuid);
      out.push(uuid);
    }
  };

  for (const item of applied) {
    push(item.createdNodeUuid);
    if (item.action.type === "connect_nodes") {
      push(item.action.sourceUuid);
      push(item.action.targetUuid);
    }
  }
  push(selectedNodeUuid);
  for (const p of oppositePairs.slice(0, 3)) {
    push(p.source.uuid);
    push(p.target.uuid);
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      messages?: ChatTurn[];
      selectedNodeUuid?: string;
      lat?: number;
      lng?: number;
      dataset?: string;
      question?: string;
      applyEdits?: boolean;
      proposedActions?: ProposedGraphAction[];
    };

    const incomingMessages: ChatTurn[] = Array.isArray(body.messages)
      ? body.messages
          .filter(
            (m): m is ChatTurn =>
              Boolean(m) &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string" &&
              m.content.trim().length > 0
          )
          .slice(-10)
      : [];

    const lastUserMessage = [...incomingMessages].reverse().find((m) => m.role === "user")?.content?.trim();
    const userPrompt = body.question?.trim() || lastUserMessage || "";
    const casualPrompt = isShortOrCasualPrompt(userPrompt);

    const store = getEtgStore();
    const snapshot = store.getSnapshot();
    const selectedNode = body.selectedNodeUuid
      ? store.getNode(body.selectedNodeUuid)
      : undefined;

    const fallbackGeoInsight = snapshot.nodes.find(
      (n) =>
        (n.label === "Insight" || n.label === "Signal") &&
        typeof n.properties.lat === "number" &&
        typeof n.properties.lng === "number"
    );

    const targetNode = selectedNode ?? fallbackGeoInsight;
    const targetLat =
      targetNode?.properties.lat ?? (typeof body.lat === "number" ? body.lat : undefined);
    const targetLng =
      targetNode?.properties.lng ?? (typeof body.lng === "number" ? body.lng : undefined);
    const dataset: ETGDatasetId =
      targetNode?.properties.dataset || (body.dataset as ETGDatasetId) || "nasa_power";

    const targetSeries = targetNode
      ? targetNode.properties.series ?? store.getNodeSeries(targetNode.uuid)
      : undefined;

    let telemetry: TrendAnalysisSummary | null = null;
    if (
      targetNode &&
      Array.isArray(targetSeries) &&
      targetSeries.length >= 5 &&
      targetLat !== undefined &&
      targetLng !== undefined
    ) {
      telemetry = analyzeTimeSeries(targetSeries, {
        lat: targetLat,
        lng: targetLng,
        dataset,
        parameter: targetNode.properties.parameter || targetNode.properties.name,
        unit: targetNode.properties.unit || "value",
        slopeUnit: targetNode.properties.slope_unit || "unit/yr",
        provenance: targetNode.properties.provenance_source || "Empirical Dataset (Imported)",
      });
    } else if (!casualPrompt && targetLat !== undefined && targetLng !== undefined) {
      try {
        telemetry = await fetchEarthTimeSeries(targetLat, targetLng, dataset);
      } catch {
        telemetry = null;
      }
    }

    const oppositePairs = snapshot.oppositeTrendPairs;
    const traversal = targetNode
      ? store.traverseSubgraph({ rootUuid: targetNode.uuid, maxHops: 2, direction: "both" })
      : null;
    const candidateLinks = targetNode
      ? store.discoverCandidateLinks({ anchorUuid: targetNode.uuid, limit: 3 })
      : store.discoverCandidateLinks({ limit: 3 });

    let prediction: GraphPredictionResult | null = null;
    if (targetNode && Array.isArray(targetSeries) && targetSeries.length >= 10) {
      try {
        prediction = predictFromGraph(store, { targetUuid: targetNode.uuid, maxHops: 2 });
      } catch {
        prediction = null;
      }
    }

    const microscope = scanTrendMicroscope(store, {
      focusNodeUuid: targetNode?.uuid,
      maxHops: 2,
      topK: 5,
    });
    const microscopeSummary = {
      engineUsed: microscope.engineUsed,
      nodeCount: microscope.nodeCount,
      verifiedCouplingsCount: microscope.verifiedCouplings.length,
      suppressedIllusionsCount: microscope.suppressedIllusions.length,
      brief: microscope.aiPerceptionBrief,
    };

    const allowEdits = body.applyEdits !== false;
    const explicitActions = Array.isArray(body.proposedActions) ? body.proposedActions : [];
    const systemPrompt = buildSystemInstruction(allowEdits);

    const buildGraphContextSnapshot = () =>
      [
        `Current Graph State: ${snapshot.stats.totalNodes} nodes, ${snapshot.stats.totalEdges} edges, ${snapshot.stats.corroboratedTrends} corroborated trends.`,
        `Focused Node: ${selectedNode ? `${selectedNode.properties.name} [${selectedNode.uuid}] (${selectedNode.label})` : "None (Global Workspace)"}`,
        body.lat !== undefined && body.lng !== undefined
          ? `Active Map Probe Pin: (${body.lat.toFixed(3)}, ${body.lng.toFixed(3)}) [${dataset}]`
          : "",
        telemetry
          ? `Telemetry at (${telemetry.lat.toFixed(2)}, ${telemetry.lng.toFixed(2)}) [${telemetry.parameter}]: Mann-Kendall p=${telemetry.mannKendall.pValue.toFixed(4)}, Theil-Sen slope=${telemetry.theilSen.slope.toFixed(3)} ${telemetry.slopeUnit}, Verdict=${telemetry.verdict}.`
          : "",
        traversal
          ? `2-Hop Neighborhood: ${traversal.nodes.length} nodes (${Object.values(traversal.roleByNode).filter((r) => r === "upstream").length} upstream drivers, ${Object.values(traversal.roleByNode).filter((r) => r === "downstream").length} downstream effects).`
          : "",
        prediction
          ? `Graph-Aware Prediction: ${prediction.summary} Next step forecast: ${prediction.nextForecast.graphAwarePred.toFixed(2)} ${prediction.unit}.`
          : "",
        microscope.nodeCount > 0
          ? `AI Trend Microscope Perception:\n${microscope.aiPerceptionBrief}`
          : "",
        candidateLinks.length > 0
          ? `Latent Unwired Links: ${candidateLinks.map((c) => `${c.sourceName} [${c.sourceUuid}] --[${c.suggestedType}]--> ${c.targetName} [${c.targetUuid}] (r=${c.pearsonR ?? "struct"})`).join("; ")}`
          : "",
        oppositePairs.length > 0
          ? `Opposite Trend Pairs: ${oppositePairs
              .slice(0, 4)
              .map(
                (p) =>
                  `${p.source.properties.name} [${p.source.uuid}] -> ${p.target.properties.name} [${p.target.uuid}] (r=${p.correlationR ?? "N/A"}): ${p.rationale}`
              )
              .join(" | ")}`
          : "",
        snapshot.nodes.length > 0
          ? `Available Graph Nodes (sample):\n${snapshot.nodes
              .slice(0, 14)
              .map(
                (n) =>
                  `- ${n.properties.name} [${n.uuid}] (${n.label}, region=${n.properties.region ?? "N/A"})`
              )
              .join("\n")}`
          : "Available Graph Nodes: (empty — 0 nodes yet; you can ingest live signals or create Concept/Insight nodes).",
      ]
        .filter(Boolean)
        .join("\n");

    const buildNormalizedTurns = (): ChatTurn[] => {
      const turns = [...incomingMessages];
      const latestText =
        userPrompt ||
        "Explain the active Earth trend, statistical significance, and cross-region teleconnections.";
      if (turns.length === 0) {
        turns.push({ role: "user", content: latestText });
      } else if (turns[turns.length - 1].role !== "user") {
        turns.push({ role: "user", content: latestText });
      }
      const contextBlock = buildGraphContextSnapshot();
      const lastIdx = turns.length - 1;
      turns[lastIdx] = {
        role: "user",
        content: `[LIVE ETG CONTEXT]\n${contextBlock}\n\n[USER MESSAGE]\n${turns[lastIdx].content}`,
      };
      return turns;
    };

    const formatEditOutcome = (
      applied: AppliedGraphActionResult[],
      blocked: AppliedGraphActionResult[]
    ) => ({
      appliedActions: applied.map((a) => ({
        type: a.action.type,
        summary: a.summary,
        createdNodeUuid: a.createdNodeUuid,
        createdEdgeUuid: a.createdEdgeUuid,
      })),
      blockedActions: blocked.map((b) => ({
        type: b.action.type,
        rule: b.verdict.rule,
        reason: b.verdict.reason,
      })),
      updatedSnapshot: applied.length > 0 ? store.getSnapshot() : undefined,
    });

    // 1. Primary LLM: DeepSeek (deepseek-chat) when DEEPSEEK_API_KEY is set
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    if (deepseekKey && !deepseekKey.startsWith("your-")) {
      try {
        const turns = buildNormalizedTurns();
        const dsRes = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${deepseekKey}`,
          },
          signal: AbortSignal.timeout(12000),
          body: JSON.stringify({
            model: "deepseek-chat",
            temperature: 0.3,
            messages: [
              { role: "system", content: systemPrompt },
              ...turns.map((t) => ({ role: t.role, content: t.content })),
            ],
          }),
        });

        if (dsRes.ok) {
          const data = (await dsRes.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const rawText = data.choices?.[0]?.message?.content;
          if (rawText) {
            const parsed = parseLlmJsonResponse(rawText);
            const combinedActions = allowEdits
              ? [...explicitActions, ...parsed.actions]
              : [];
            const { applied, blocked } = await validateAndApplyGraphActionsAsync(
              store,
              combinedActions
            );
            const freshSnap = applied.length > 0 ? store.getSnapshot() : snapshot;
            return NextResponse.json({
              engine: "DeepSeek Chat + ETG Integrity Guard",
              briefing: parsed.briefing,
              citedNodes: collectCitedNodes(applied, selectedNode?.uuid, freshSnap.oppositeTrendPairs),
              microscopeSummary,
              ...formatEditOutcome(applied, blocked),
              telemetrySummary: telemetry
                ? {
                    verdict: telemetry.verdict,
                    pValue: telemetry.mannKendall.pValue,
                    slope: telemetry.theilSen.slope,
                    slopeUnit: telemetry.slopeUnit,
                  }
                : undefined,
            });
          }
        }
      } catch {
        // Fall through to Gemini / deterministic reasoner
      }
    }

    // 2. Gemini (primary when DEEPSEEK_API_KEY is unset, or fallback)
    const geminiKey = process.env.GEMINI_API_KEY;
    const geminiModel = process.env.GEMINI_MODEL || "gemini-4-hydrogen";
    if (geminiKey && !geminiKey.startsWith("your-")) {
      try {
        const turns = buildNormalizedTurns();
        const isGemini3or4 = /gemini-[34]/i.test(geminiModel);
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(12000),
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: systemPrompt }],
              },
              contents: turns.map((t) => ({
                role: t.role === "assistant" ? "model" : "user",
                parts: [{ text: t.content }],
              })),
              generationConfig: {
                temperature: 0.35,
                responseMimeType: "application/json",
                ...(isGemini3or4 ? { thinkingConfig: { thinkingLevel: "LOW" } } : {}),
              },
            }),
          }
        );

        if (geminiRes.ok) {
          const data = (await geminiRes.json()) as {
            candidates?: Array<{
              content?: { parts?: Array<{ thought?: boolean; text?: string }> };
            }>;
          };
          const parts = data.candidates?.[0]?.content?.parts ?? [];
          const rawText = parts
            .filter((p) => !p.thought && typeof p.text === "string")
            .map((p) => p.text ?? "")
            .join("\n")
            .trim();
          if (rawText) {
            const parsed = parseLlmJsonResponse(rawText);
            const combinedActions = allowEdits
              ? [...explicitActions, ...parsed.actions]
              : [];
            const { applied, blocked } = await validateAndApplyGraphActionsAsync(
              store,
              combinedActions
            );
            const freshSnap = applied.length > 0 ? store.getSnapshot() : snapshot;
            return NextResponse.json({
              engine: `${geminiModel} + ETG Integrity Guard`,
              briefing: parsed.briefing,
              citedNodes: collectCitedNodes(applied, selectedNode?.uuid, freshSnap.oppositeTrendPairs),
              microscopeSummary,
              ...formatEditOutcome(applied, blocked),
              telemetrySummary: telemetry
                ? {
                    verdict: telemetry.verdict,
                    pValue: telemetry.mannKendall.pValue,
                    slope: telemetry.theilSen.slope,
                    slopeUnit: telemetry.slopeUnit,
                  }
                : undefined,
            });
          }
        }
      } catch {
        // Fall back to deterministic scientific synthesis
      }
    }

    // 3. Deterministic Scientific Reasoner + Graph Integrity Guard fallback
    const deterministicActions = allowEdits
      ? [
          ...explicitActions,
          ...inferDeterministicActionsFromQuestion(
            userPrompt,
            candidateLinks,
            selectedNode?.uuid
          ),
        ]
      : [];
    const { applied, blocked } = await validateAndApplyGraphActionsAsync(
      store,
      deterministicActions
    );
    const freshSnap = applied.length > 0 ? store.getSnapshot() : snapshot;

    // Proportional friendly response for short/casual messages when no edits happened
    if (casualPrompt && applied.length === 0 && blocked.length === 0) {
      const reply =
        userPrompt.length <= 3
          ? `Hey! Looks like a quick note ("${userPrompt}"). Ask about an Earth trend or tell me to add a live signal, create a node, or connect links (${snapshot.stats.totalNodes}N · ${snapshot.stats.totalEdges}E).`
          : `Hi! Ask about any region or tell me how to edit the Knowledge Graph — e.g., add a live Boulder signal, create an Insight, or wire latent connections (${snapshot.stats.totalNodes}N · ${snapshot.stats.totalEdges}E).`;
      return NextResponse.json({
        engine: "Deterministic ETG Reasoner + Integrity Guard",
        briefing: reply,
        citedNodes: selectedNode ? [selectedNode.uuid] : [],
        microscopeSummary,
        ...formatEditOutcome(applied, blocked),
      });
    }

    if (freshSnap.nodes.length === 0 && !telemetry && applied.length === 0 && blocked.length === 0) {
      return NextResponse.json({
        engine: "Deterministic ETG Scientific Reasoner",
        briefing:
          "The Earth Trend Graph is currently empty (0 nodes). Ask me to add a live NASA signal for any city, create a Concept/Insight node, or run **Load Live Global Pins**.",
        citedNodes: [],
        ...formatEditOutcome(applied, blocked),
      });
    }

    const activeDipole =
      freshSnap.oppositeTrendPairs.find(
        (p) =>
          p.source.uuid === selectedNode?.uuid || p.target.uuid === selectedNode?.uuid
      ) || freshSnap.oppositeTrendPairs[0];

    const lines: string[] = [];
    if (selectedNode && telemetry) {
      lines.push(
        `**Signal Attribution (${selectedNode.label} · ${selectedNode.uuid}):** "${selectedNode.properties.name}" shows a **${telemetry.verdict}** at (${telemetry.lat.toFixed(2)}°, ${telemetry.lng.toFixed(2)}°) with Mann-Kendall \`p = ${telemetry.mannKendall.pValue.toFixed(4)}\` and Theil-Sen slope \`${telemetry.theilSen.slope >= 0 ? "+" : ""}${telemetry.theilSen.slope.toFixed(3)} ${telemetry.slopeUnit}\` (${telemetry.provenance}).`
      );
    } else if (telemetry) {
      lines.push(
        `**Global Earth Trend Summary:** Tracking **${freshSnap.stats.corroboratedTrends} corroborated trends**, **${freshSnap.stats.provisionalCount} provisional signal(s)**, and **${freshSnap.stats.oppositeTrendPairsCount} active opposite-trend dipoles** across ${freshSnap.stats.totalNodes} empirical nodes. Focus telemetry at (${telemetry.lat.toFixed(2)}°, ${telemetry.lng.toFixed(2)}°) yields Mann-Kendall \`p = ${telemetry.mannKendall.pValue.toFixed(4)}\` (${telemetry.verdict}).`
      );
    } else {
      lines.push(
        `**Global Earth Trend Summary:** Tracking **${freshSnap.stats.corroboratedTrends} corroborated trends** across **${freshSnap.stats.totalNodes} empirical nodes** and **${freshSnap.stats.totalEdges} edges**.`
      );
    }

    if (activeDipole) {
      lines.push(
        `**Cross-Region Opposite Teleconnection:** \`${activeDipole.source.properties.name}\` [${activeDipole.source.uuid}] diverges against \`${activeDipole.target.properties.name}\` [${activeDipole.target.uuid}] (${activeDipole.correlationR !== undefined ? `r = ${activeDipole.correlationR.toFixed(2)}` : "inverse coupling"}): ${activeDipole.rationale}`
      );
    }

    if (prediction) {
      lines.push(
        `**Graph-Aware Forecast (${prediction.nextForecast.nextPeriodLabel}):** ${prediction.summary} Next forecast: \`${prediction.nextForecast.graphAwarePred.toFixed(2)} ± ${prediction.nextForecast.ci95HalfWidth.toFixed(2)} ${prediction.unit}\`.`
      );
    }

    if (candidateLinks.length > 0) {
      lines.push(
        `**Suggested Unwired Connections:** ${candidateLinks.map((c) => `\`${c.sourceName}\` —[${c.suggestedType}]→ \`${c.targetName}\`${c.pearsonR !== undefined ? ` (r=${c.pearsonR.toFixed(2)})` : ""}`).join("; ")}.`
      );
    }

    if (microscope.nodeCount > 0) {
      const onsetNodes = microscope.nodes.filter((n) => n.onsetProb >= 0.55);
      const falseTrendNodes = microscope.nodes.filter((n) => n.dealiasing.falseTrendProb >= 0.52);
      const topCoupling = microscope.verifiedCouplings[0];
      const topIllusion = microscope.suppressedIllusions[0];
      const microBits: string[] = [
        `${microscope.nodeCount} node(s) scanned`,
        onsetNodes.length > 0
          ? `${onsetNodes.length} emerging onset (${onsetNodes[0].name}${onsetNodes[0].preMannKendallAlert ? ", pre-MK" : ""})`
          : "0 new onsets",
      ];
      if (topCoupling) {
        microBits.push(
          `verified ${topCoupling.polarity}: ${topCoupling.sourceName} -> ${topCoupling.targetName} (lag=${topCoupling.optimalLagSteps}, P=${Math.round(topCoupling.trueCouplingProb * 100)}%)`
        );
      }
      if (topIllusion) {
        microBits.push(
          `suppressed confounder: ${topIllusion.sourceName} -> ${topIllusion.targetName} (P_illusion=${Math.round(topIllusion.confounderProb * 100)}%)`
        );
      }
      if (falseTrendNodes.length > 0) {
        microBits.push(
          `${falseTrendNodes.length} cycle/glitch warning (${falseTrendNodes[0].name})`
        );
      }
      lines.push(`**AI Trend Microscope (${microscope.engineUsed}):** ${microBits.join(" · ")}.`);
    }

    if (applied.length > 0) {
      lines.push(
        `**Graph Edits Applied:** ${applied.map((a) => a.summary).join("; ")}.`
      );
    }
    if (blocked.length > 0) {
      lines.push(
        `**Graph Integrity Guard Blocked Harmful Change(s):** ${blocked.map((b) => b.summary).join("; ")}.`
      );
    }

    lines.push(
      `**Epistemic Integrity:** Multi-source corroboration enforces ≥2 independent observational systems, while historical revisions remain auditable via \`supersedes\` lineage (${freshSnap.stats.supersededCount} superseded assessment preserved).`
    );

    return NextResponse.json({
      engine: "Deterministic ETG Reasoner + Integrity Guard",
      briefing: lines.join("\n\n"),
      citedNodes: collectCitedNodes(applied, selectedNode?.uuid, freshSnap.oppositeTrendPairs),
      traversalCount: traversal?.nodes.length,
      candidateLinksCount: candidateLinks.length,
      microscopeSummary,
      ...formatEditOutcome(applied, blocked),
      predictionSummary: prediction
        ? {
            skillLiftVsSelfPct: prediction.skillLiftVsSelfPct,
            graphRmse: prediction.graphAware.rmse,
            nextPred: prediction.nextForecast.graphAwarePred,
          }
        : undefined,
      telemetrySummary: telemetry
        ? {
            verdict: telemetry.verdict,
            pValue: telemetry.mannKendall.pValue,
            slope: telemetry.theilSen.slope,
            slopeUnit: telemetry.slopeUnit,
          }
        : undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Detective synthesis failed" },
      { status: 500 }
    );
  }
}
