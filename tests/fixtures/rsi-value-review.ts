/** Passing judge stub for pre-existing generator/learning tests; gate semantics have separate tests. */
export function passingValueReview(prompt: string): string | undefined {
  if (prompt.startsWith('RSI_PROTOCOL_V2:value-presentation\n')) {
    const cards = JSON.parse(prompt.split('\n').find(line => line.startsWith('DISPLAY_DATA='))!.slice('DISPLAY_DATA='.length));
    return JSON.stringify({ readings: cards.map((item: any) => ({ candidateId: item.candidateId, status: 'pass', problem: item.title, action: item.action, benefit: '支持当前项目判断', reason: '测试桩：展示语义完整', correction: '' })) });
  }
  if (!prompt.startsWith('RSI_PROTOCOL_V2:value-judge\n')) return;
  const candidates = JSON.parse(prompt.split('\n').find(line => line.startsWith('CANDIDATES_DATA='))!.slice('CANDIDATES_DATA='.length));
  const reference = JSON.parse(prompt.split('\n').find(line => line.startsWith('REFERENCE_DATA='))!.slice('REFERENCE_DATA='.length));
  const evidence = reference.evidence.slice(0, 2);
  return JSON.stringify({ verdicts: candidates.map((item: any) => {
    const gate = { status: 'pass', reason: '独立测试桩判定通过', evidenceIds: evidence.map((source: any) => source.id), counterEvidenceIds: [], support: evidence.map((source: any) => ({ evidenceId: source.id, quote: source.text.slice(0, 100).trim(), explains: '流程测试引用' })), counterSupport: [] };
    return { candidateId: item.candidateId, currentProgress: '测试桩进展', missingHelp: '测试桩缺少的帮助', difficulty: gate, need: gate, benefit: gate, correction: '保留当前具体依据', reconsiderWhen: '出现新的项目进展后重新判断' };
  }) });
}
