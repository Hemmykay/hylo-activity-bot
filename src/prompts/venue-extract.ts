import type { AIRequest } from '@/services/ai/ai.types.js';

export function buildVenueExtractPrompt(rawInput: string): AIRequest {
  // Scale token budget with input length so rich descriptions don't get cut off
  const estimatedInputTokens = Math.ceil(rawInput.length / 4);
  const maxTokens = Math.min(Math.max(estimatedInputTokens + 400, 800), 2000);

  return {
    systemPrompt: `You extract structured third-party venue information from natural language descriptions.
The input may contain markdown formatting (bullet points, bold text, dashes), multiple paragraphs, and detailed context about how XP is calculated.
Return ONLY valid JSON with no markdown fences, no preamble, no trailing text.`,
    messages: [
      {
        role: 'user',
        content: `Extract venue information from this description:
"""
${rawInput}
"""

Return JSON in this exact format:
{
  "name": "<proper name of the platform or protocol>",
  "description": "<1–2 sentences describing what this venue does>",
  "context": "<important context about HOW or WHY XP is calculated — e.g. calculation basis, special rules, what counts toward XP. Empty string if nothing notable>",
  "assets": [
    {
      "asset": "<asset or LP pool name, e.g. 'xSOL', 'hyUSD-USDC LP', 'hyUSD-JitoSOL LP'>",
      "xpRate": "<XP rate exactly as described, e.g. '8 Hylo XP per dollar of total position value'>",
      "notes": "<any specific note for this asset, or empty string>"
    }
  ]
}

Rules:
- LP pool pairs like "hyUSD-USDC pool" or "hyUSD–JitoSOL pool" are valid assets — name them like "hyUSD-USDC LP"
- Preserve XP rate wording exactly as given in the input
- The "context" field is for venue-level explanations: how XP is measured, what value counts, special conditions
- Strip markdown symbols (**, •, –) from text values but keep the meaning
- If no assets or rates are mentioned, use an empty array
- Every field must be present; use empty string for optional text fields if not applicable`,
      },
    ],
    temperature: 0.1,
    maxTokens,
  };
}
