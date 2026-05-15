import Anthropic from "@anthropic-ai/sdk";

export function getAnthropic(apiKey: string | undefined): Anthropic {
  if (!apiKey) {
    throw new Error("anthropic_not_configured");
  }
  return new Anthropic({ apiKey });
}

export interface ProductAnalysis {
  productName: string;
  oneLiner: string;
  targetAudience: string;
  keywords: string[];
  valueProp: string;
}
