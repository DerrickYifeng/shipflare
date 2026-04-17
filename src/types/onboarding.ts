export type ProductLifecyclePhase = 'pre_launch' | 'launched' | 'scaling';

export interface ExtractedProfile {
  url: string;
  name: string;
  description: string;
  keywords: string[];
  valueProp: string;
  ogImage: string | null;
  seoAudit: Record<string, unknown> | null;
}
