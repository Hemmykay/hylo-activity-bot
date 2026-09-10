/**
 * Shared "does this free text refer to a known Hylo asset" matcher.
 * Used wherever a symbol or name needs to be recognised inside a larger
 * string — customer messages, admin-pasted text, legacy free-text data.
 */

export function assetMentionedIn(asset: { symbol: string; name: string }, lowerText: string): boolean {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const symbolRe = new RegExp(`\\b${esc(asset.symbol.toLowerCase())}\\b`);
  const nameRe = new RegExp(`\\b${esc(asset.name.toLowerCase())}\\b`);
  return symbolRe.test(lowerText) || nameRe.test(lowerText);
}

/**
 * Finds the best-matching asset for a piece of free text. Longest symbol
 * first, so "HYLOSOL+" is preferred over "HYLOSOL" when both would match.
 */
export function findMatchingAsset<T extends { symbol: string; name: string }>(
  text: string,
  assets: T[],
): T | null {
  const lower = text.toLowerCase();
  return (
    [...assets]
      .sort((a, b) => b.symbol.length - a.symbol.length)
      .find((a) => assetMentionedIn(a, lower)) ?? null
  );
}
