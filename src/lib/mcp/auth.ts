import type { NextRequest } from "next/server";

/**
 * Validates optional communal ETG_API_KEY.
 * When ETG_API_KEY is unset (default hackathon / local communal mode),
 * requests are openly permitted so AI models & community sensors connect out of the box.
 */
export function isAuthorizedMcpRequest(req: NextRequest): boolean {
  const configuredKey = process.env.ETG_API_KEY?.trim();
  if (!configuredKey) return true;

  const authHeader = req.headers.get("authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (bearer && bearer === configuredKey) return true;

  const url = new URL(req.url);
  const queryKey = url.searchParams.get("api_key") || url.searchParams.get("key") || "";
  return queryKey === configuredKey;
}
