export interface ExtractedProfile {
  url: string;
  name: string;
  description: string;
  keywords: string[];
  valueProp: string;
  /** AI-inferred audience (e.g. "indie developers", "creators"). Empty
   * string when extraction couldn't determine one — user fills in
   * Stage 3 review. */
  targetAudience: string;
  ogImage: string | null;
  seoAudit: Record<string, unknown> | null;
}
