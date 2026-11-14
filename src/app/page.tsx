import { getEtgStore } from "@/lib/graph/etgStore";
import { DetectiveWorkspace } from "@/components/DetectiveWorkspace";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const snapshot = getEtgStore().getSnapshot();
  return <DetectiveWorkspace initialSnapshot={snapshot} />;
}
