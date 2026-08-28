/**
 * Rough token estimator, used only when neither CLAIR Base nor the LLM report
 * token counts. Approximation: ~4 characters per token for Latin text and
 * ~2 characters per token for Cyrillic (typical for cl100k-style BPE).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cyrillic = 0;
  let total = 0;
  for (const ch of text) {
    total += 1;
    if (ch >= '\u0400' && ch <= '\u04FF') cyrillic += 1;
  }
  const rest = total - cyrillic;
  return Math.max(1, Math.ceil(cyrillic / 2 + rest / 4));
}
