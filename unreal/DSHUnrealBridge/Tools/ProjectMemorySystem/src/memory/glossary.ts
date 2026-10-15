export interface GlossaryTerm {
  term: string;
  definition: string;
  sourcePaths: string[];
  sourceHash: string;
}

export function extractGlossaryTerms(text: string, sourcePaths: string[], sourceHash: string): GlossaryTerm[] {
  const terms: GlossaryTerm[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^[-*]?\s*([^:：]{2,40})[:：]\s*(.{4,})$/.exec(line);
    if (!match) continue;
    if (/待填写|待确认|TODO/i.test(line)) continue;
    terms.push({
      term: match[1].trim(),
      definition: match[2].trim(),
      sourcePaths,
      sourceHash
    });
  }
  return terms;
}

export function emptyGlossary(): GlossaryTerm[] {
  return [];
}
