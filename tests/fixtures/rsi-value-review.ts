/** Passing judge stub for pre-existing generator/learning tests; gate semantics have separate tests. */
export function passingValueReview(prompt: string): string | undefined {
  if (!prompt.startsWith('RSI_PROTOCOL_V2:value-judge\n')) return;
  const candidates = JSON.parse(prompt.split('\n').find(line => line.startsWith('CANDIDATES_DATA='))!.slice('CANDIDATES_DATA='.length));
  return JSON.stringify({ verdicts: candidates.map((item: any) => {
    const gate = { status: 'pass', reason: '独立测试桩判定通过', evidenceIds: item.suggestion.evidenceIds, counterEvidenceIds: [] };
    return { candidateId: item.candidateId, difficulty: gate, need: gate, benefit: gate, correction: '保留当前具体依据', reconsiderWhen: '出现新的项目进展后重新判断' };
  }) });
}
