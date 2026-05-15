import type { Metadata } from "next";
import { HistoryTab } from "../_components/history-tab";

export const metadata: Metadata = { title: "Briefing — History" };
export const dynamic = "force-dynamic";

export default function BriefingHistoryPage() {
  return <HistoryTab />;
}
