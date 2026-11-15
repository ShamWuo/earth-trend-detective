import { NextRequest, NextResponse } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import {
  buildLiveTelemetryBriefingFallback,
  sanitizeCitation,
  sanitizeResearchDossier,
} from "@/lib/research/dossierUtils";
import {
  buildNodeClaimStanceContext,
  buildNodeLiteratureQuery,
  type ClaimStanceContext,
  evaluateCitationClaimStance,
  normalizeDoiIdentifier,
  searchPeerReviewedEarthLiterature,
  verifyDoiMetadataDetailed,
} from "@/lib/research/scholarlyLiteratureClient";
import type { ETGScientificCitation } from "@/types/etg";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const rawQ = searchParams.get("q")?.trim() || "";
    const nodeUuid = searchParams.get("nodeUuid")?.trim() || "";
    const limitParam = Number(searchParams.get("limit") || "6");
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(12, Math.round(limitParam))) : 6;

    let query = rawQ;
    let claimContext: ClaimStanceContext | undefined;
    if (nodeUuid) {
      const store = getEtgStore();
      const node = store.getNode(nodeUuid);
      if (!node) {
        return NextResponse.json({ error: `ETG node "${nodeUuid}" not found.` }, { status: 404 });
      }
      claimContext = buildNodeClaimStanceContext(node);
      if (!query) {
        query = buildNodeLiteratureQuery(node);
      }
    }

    if (!query || query.length < 3) {
      return NextResponse.json(
        { error: "Provide a search query (`q`) of at least 3 characters or a valid `nodeUuid`." },
        { status: 400 }
      );
    }

    const results = await searchPeerReviewedEarthLiterature(query, limit, {
      claimContext,
    });
    return NextResponse.json({
      query,
      results,
      count: results.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scholarly literature search failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return NextResponse.json({ error: "JSON object payload required." }, { status: 400 });
    }

    const body = rawBody as {
      action?: unknown;
      doi?: unknown;
      nodeUuid?: unknown;
      citation?: unknown;
    };

    const action = typeof body.action === "string" ? body.action.trim() : "verify_doi";

    if (action === "verify_doi") {
      const rawDoi =
        typeof body.doi === "string"
          ? body.doi
          : body.citation && typeof body.citation === "object" && "doi" in body.citation
            ? String((body.citation as Record<string, unknown>).doi ?? "")
            : "";
      const outcome = await verifyDoiMetadataDetailed(rawDoi);
      if (outcome.status === "not_found") {
        return NextResponse.json(
          { verified: false, doi: outcome.doi, error: outcome.reason },
          { status: 404 }
        );
      }
      if (outcome.status === "unavailable") {
        return NextResponse.json(
          { verified: false, doi: outcome.doi, error: outcome.reason },
          { status: 503 }
        );
      }
      return NextResponse.json({
        verified: true,
        doi: outcome.doi,
        citation: outcome.citation,
      });
    }

    if (action === "attach_citation") {
      const nodeUuid = typeof body.nodeUuid === "string" ? body.nodeUuid.trim() : "";
      if (!nodeUuid) {
        return NextResponse.json({ error: "nodeUuid is required." }, { status: 400 });
      }
      const store = getEtgStore();
      const node = store.getNode(nodeUuid);
      if (!node) {
        return NextResponse.json({ error: `ETG node "${nodeUuid}" not found.` }, { status: 404 });
      }

      let citationToAttach: ETGScientificCitation | undefined = body.citation
        ? sanitizeCitation(body.citation)
        : undefined;
      const doiCandidate = normalizeDoiIdentifier(body.doi ?? citationToAttach?.doi);

      if (doiCandidate) {
        const outcome = await verifyDoiMetadataDetailed(doiCandidate);
        if (outcome.status === "not_found") {
          return NextResponse.json(
            { error: `DOI verification failed: ${outcome.reason}`, verified: false },
            { status: 422 }
          );
        }
        if (outcome.status === "verified") {
          citationToAttach = {
            ...citationToAttach,
            ...outcome.citation,
            abstract_snippet:
              outcome.citation.abstract_snippet ?? citationToAttach?.abstract_snippet,
          };
        }
      }

      if (!citationToAttach) {
        return NextResponse.json(
          { error: "Provide a valid citation object or verifiable DOI." },
          { status: 400 }
        );
      }

      citationToAttach = evaluateCitationClaimStance(
        citationToAttach,
        buildNodeClaimStanceContext(node)
      );

      const snap = store.getSnapshot();
      const nodesById = new Map(snap.nodes.map((n) => [n.uuid, n]));
      const baseDossier =
        node.properties.dossier ??
        buildLiveTelemetryBriefingFallback(node, snap.edges, nodesById);

      const mergedCitations = [...baseDossier.citations];
      const existingIdx = mergedCitations.findIndex(
        (c) =>
          (citationToAttach!.doi && c.doi === citationToAttach!.doi) ||
          c.title.toLowerCase() === citationToAttach!.title.toLowerCase()
      );
      if (existingIdx >= 0) {
        mergedCitations[existingIdx] = citationToAttach;
      } else {
        mergedCitations.push(citationToAttach);
      }

      const nextDossier = sanitizeResearchDossier({
        ...baseDossier,
        citations: mergedCitations,
        updated_at: new Date().toISOString(),
        researched_by: baseDossier.researched_by ?? "human",
      });
      if (!nextDossier) {
        return NextResponse.json(
          { error: "Resulting research dossier failed scientific validation." },
          { status: 422 }
        );
      }

      const updatedNode = store.updateNode(node.uuid, { dossier: nextDossier });
      return NextResponse.json({
        attached: true,
        citation: citationToAttach,
        node: updatedNode,
        updatedSnapshot: store.getSnapshot(),
      });
    }

    return NextResponse.json(
      { error: `Unsupported action "${action}". Expected "verify_doi" or "attach_citation".` },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Literature API request failed" },
      { status: 500 }
    );
  }
}
