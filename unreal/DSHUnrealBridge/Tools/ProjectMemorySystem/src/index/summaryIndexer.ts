export interface SummaryIndexResult {
  summariesIndexed: number;
  phase: "skeleton";
}

export async function indexSummaries(): Promise<SummaryIndexResult> {
  return {
    summariesIndexed: 0,
    phase: "skeleton"
  };
}
