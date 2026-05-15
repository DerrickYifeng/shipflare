import type { Metadata } from "next";
import { GrowthContent } from "./growth-content";

export const metadata: Metadata = { title: "Growth" };
export const dynamic = "force-dynamic";

export default function GrowthPage() {
  return <GrowthContent />;
}
