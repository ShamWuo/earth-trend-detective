import { getEtgStore } from "@/lib/graph/etgStore";
import { DetectiveWorkspace } from "@/components/DetectiveWorkspace";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const rawDemo = Array.isArray(sp?.demo) ? sp.demo[0] : sp?.demo;
  const initialDemoMode =
    rawDemo === "spaceapps" || rawDemo === "veritas" ? rawDemo : null;
  const rawBriefing = Array.isArray(sp?.briefing) ? sp.briefing[0] : sp?.briefing;
  const initialBriefingUuid =
    typeof rawBriefing === "string" && rawBriefing.trim().length > 0
      ? rawBriefing.trim()
      : null;
  const snapshot = getEtgStore().getSnapshot();
  return (
    <DetectiveWorkspace
      initialSnapshot={snapshot}
      initialDemoMode={initialDemoMode}
      initialBriefingUuid={initialBriefingUuid}
    />
  );
}
