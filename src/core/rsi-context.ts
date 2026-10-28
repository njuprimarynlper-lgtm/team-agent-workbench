import { valueHash } from './rsi-value-review';
import { createHash } from 'node:crypto';
import { rsiFeedbackState, type RsiAnswer, type RsiConfig, type RsiCoverage, type RsiEvidence, type RsiMemory, type RsiMemoryEntry, type RsiProject, type RsiReaction } from '../shared/rsi';

export const evidenceKey = (item: RsiEvidence) => `${item.source}:${item.sourceId}`;
export const emptyMemory = (): RsiMemory => ({ analyzed: {}, sessions: {} });
export function latestEvidence(evidence: RsiEvidence[]) {
  const latest = new Map<string, RsiEvidence>();
  for (const item of evidence) if (item.source !== 'evaluation' && Date.parse(item.eventAt) <= Date.now() && Date.parse(item.observedAt) <= Date.now()) latest.set(evidenceKey(item), item);
  return [...latest.values()];
}
/** Historical feedback remains auditable, but only the current episode is recommendation input. */
export function latestProjectEvidence(project: RsiProject) {
  const knownSuggestions = new Set(project.suggestions.map(item => item.id)), currentIds = new Set<string>();
  for (const suggestionId of knownSuggestions) {
    const { decision, feedback, supplement, outcome } = rsiFeedbackState(suggestionId, project.events);
    const events = project.events.filter(event => event.suggestionId === suggestionId);
    const current = [decision, feedback, supplement, outcome,
      events.filter(event => ['dismissed', 'reopened'].includes(event.kind)).at(-1),
      ...['action', 'deferred', 'edited'].map(kind => events.filter(event => event.kind === kind).at(-1))];
    for (const event of current) if (event) {
      // A decision or association may carry feedback that a later edit cleared/replaced.
      // Its current intent is represented separately below; do not replay its obsolete text.
      if (['accepted', 'rejected', 'feedback', 'supplement'].includes(event.kind) && event.text && event.id !== feedback?.id) continue;
      currentIds.add(event.evidenceId);
    }
  }
  return latestEvidence(project.evidence).filter(item => item.source !== 'interface' || !item.suggestionId || !knownSuggestions.has(item.suggestionId) || currentIds.has(item.id));
}
export function pendingEvidence(project: RsiProject) {
  return latestProjectEvidence(project).filter(item => {
    const cursor = project.memory?.analyzed[evidenceKey(item)];
    return cursor?.evidenceId !== item.id || cursor.offset < item.text.length;
  });
}
const tokens = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_-]{3,}|[\u4e00-\u9fff]{2}/g) || []);
const memoryId = (sessionId: string, evidenceIds: string[], fragments?: RsiMemoryEntry['fragments']) =>
  createHash('sha256').update(JSON.stringify([sessionId, evidenceIds, fragments])).digest('hex').slice(0, 24);
function validMemoryEntries(sessionId: string, value: RsiMemory['sessions'][string], validIds: Set<string>) {
  // Older installations did not record spans. Preserve their summary without inventing coverage.
  const entries = value.entries ?? [{ id: memoryId(sessionId, value.evidenceIds), summary: value.summary, evidenceIds: value.evidenceIds, updatedAt: value.updatedAt }];
  return entries.filter(entry => entry.evidenceIds.every(id => validIds.has(id)));
}
function containsNewSpan(fragments: NonNullable<RsiMemoryEntry['fragments']>, entries: RsiMemoryEntry[]) {
  return fragments.some(fragment => {
    const previous = entries.flatMap(entry => entry.fragments || [])
      .filter(value => value.evidenceId === fragment.evidenceId && value.key === fragment.key)
      .sort((a, b) => a.from - b.from || a.to - b.to);
    let coveredTo = fragment.from;
    for (const value of previous) {
      if (value.from > coveredTo) break;
      coveredTo = Math.max(coveredTo, value.to);
      if (coveredTo >= fragment.to) return false;
    }
    return coveredTo < fragment.to;
  });
}

/** A bounded, reproducible reference snapshot. A clipped source is never marked fully read. */
export function projectContext(project: RsiProject, config: RsiConfig) {
  const latest = latestProjectEvidence(project), pending = pendingEvidence(project);
  const memory = project.memory || emptyMemory(), evidence: RsiEvidence[] = [], coverage: RsiCoverage[] = [];
  const data = {
    projectId: project.scope.projectId,
    scope: '本账号可访问的项目会话及共享资料；摘要为先前判断，原文和新修正优先。',
    goals: config.goals.slice(0, Math.floor(config.contextChars / 20)),
    acceptance: config.acceptance.slice(0, Math.floor(config.contextChars / 20)),
    role: config.role.slice(0, Math.floor(config.contextChars / 30)), preference: config.preference.slice(0, Math.floor(config.contextChars / 30)),
    overview: null as RsiAnswer['state'] | null,
    sessions: [] as (RsiMemoryEntry & { sessionId: string })[],
    evidence, deltaIds: [] as string[], relatedIds: [] as string[],
    machineReviewFeedback: [] as { kind: string; title: string; action: string; stages: Record<'readability' | 'difficulty' | 'need' | 'benefit', string>; reason: string; correction: string; reconsiderWhen: string; truncated: boolean }[],
    priorRecommendations: [] as { id: string; title: string; action: string; closed: boolean; feedback: (Pick<RsiReaction, 'kind' | 'text' | 'outcome' | 'feedbackTarget'> & { eventId: string; decisionEventId?: string; at: string; textTruncated: boolean })[] }[],
    coverage: { totalSessions: new Set(latest.map(item => item.sessionId).filter(Boolean)).size, pendingSources: pending.length, remainingSources: pending.length, partial: false },
  };
  // The ledger retains full audit metadata; model input needs only the source locator.
  const serialize = () => JSON.stringify({ ...data, evidence: evidence.map(item => ({ id: item.id, source: item.source, sourceId: item.sourceId,
    sessionId: item.sessionId, sessionTitle: item.sessionTitle?.slice(0, 100), messageId: item.messageId, turnId: item.turnId, sequence: item.sequence,
    version: item.version.slice(0, 96), actor: item.actor.slice(0, 80), eventAt: item.eventAt,
    assertion: item.assertion, contentType: item.contentType, supersedes: item.supersedes, text: item.text, fragment: (item as any).fragment })) });
  const size = () => serialize().length;
  const budget = config.contextChars - 128;
  const oldOverview = memory.overview;
  // Only keep a derived overview while its referenced source versions still exist unchanged.
  const validIds = new Set(latest.map(item => item.id));
  if (oldOverview && oldOverview.state.evidenceIds.every(id => validIds.has(id))) {
    const state = oldOverview.state;
    data.overview = { progress: state.progress.slice(0, 400), blockers: state.blockers.slice(0, 3).map(value => value.slice(0, 160)), unknowns: state.unknowns.slice(0, 3).map(value => value.slice(0, 160)), evidenceIds: state.evidenceIds };
    // Omit an oversized overview intact; never truncate serialized JSON into an opaque string.
    if (JSON.stringify(data.overview).length > budget / 10) data.overview = null;
  }
  // Keep machine critique separate and bounded. A changed source/config invalidates it;
  // old criticism must not become a permanent prohibition or fabricated user preference.
  const sourceEvidenceIds = new Set<string>();
  const seenFeedback = new Set<string>();
  let feedbackChars = 0;
  for (const item of [...(project.valueFeedback || [])].reverse()) {
    const key = item.runId + ':' + item.candidateId;
    if (seenFeedback.has(key)) continue;
    seenFeedback.add(key);
    if (item.configHash !== valueHash(config) || !item.evidenceIds.every(id => validIds.has(id))) continue;
    const gates = [item.verdict.difficulty, item.verdict.need, item.verdict.benefit];
    const reason = item.verdict.presentation && item.verdict.presentation.status !== 'pass' ? item.verdict.presentation.reason : gates.find(gate => gate.status !== 'pass')?.reason || item.verdict.benefit.reason;
    const correction = item.verdict.presentation && item.verdict.presentation.status !== 'pass' ? item.verdict.presentation.correction : item.verdict.correction;
    const compact = { kind: 'machine_assessment_not_user_feedback_or_project_fact', title: item.title.slice(0, 100), action: item.action.slice(0, 160),
      stages: { readability: item.verdict.presentation?.status || 'not_evaluated', difficulty: gates[0].status, need: gates[1].status, benefit: gates[2].status }, reason: reason.slice(0, 180), correction: correction.slice(0, 200),
      reconsiderWhen: item.verdict.reconsiderWhen.slice(0, 160),
      truncated: item.title.length > 100 || item.action.length > 160 || reason.length > 180 || correction.length > 200 || item.verdict.reconsiderWhen.length > 160 };
    const length = JSON.stringify(compact).length;
    if (feedbackChars + length > Math.min(2400, budget * .24)) continue;
    data.machineReviewFeedback.push(compact); feedbackChars += length;
    for (const id of item.evidenceIds) sourceEvidenceIds.add(id);
  }
  const query = tokens(pending.map(item => item.text.slice(0, 600)).join(' ') + config.goals);
  const relevance = (item: RsiEvidence) => [...tokens(item.text.slice(0, 4000))].filter(term => query.has(term)).length;
  const pendingSessions = new Set(pending.map(item => item.sessionId));
  const memoryOrder = Object.entries(memory.sessions).flatMap(([sessionId, value]) => validMemoryEntries(sessionId, value, validIds).map(entry => ({ ...entry, sessionId })));
  const memoryRank = (entry: typeof memoryOrder[number]) => Number(pendingSessions.has(entry.sessionId)) * 20
    + Number(typeof entry.summary === 'object' && entry.summary.constraints.length > 0) * 10
    + [...tokens(JSON.stringify(entry.summary))].filter(term => query.has(term)).length;
  // Older constraints remain eligible after new fragments arrive; a large entry must not hide smaller relevant ones.
  memoryOrder.sort((a, b) => memoryRank(b) - memoryRank(a) || a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  for (const entry of memoryOrder) {
    data.sessions.push(entry);
    if (size() > budget * .25) data.sessions.pop();
  }
  function add(item: RsiEvidence, delta: boolean, cap: number) {
    if (evidence.some(value => value.id === item.id)) return;
    const previous = memory.analyzed[evidenceKey(item)];
    const offset = delta && previous?.evidenceId === item.id ? previous.offset : 0;
    const remaining = item.text.length - offset;
    const selected = { ...item, text: '', fragment: { from: offset, to: offset, total: item.text.length } };
    evidence.push(selected); (delta ? data.deltaIds : data.relatedIds).push(item.id);
    let low = 0, high = Math.min(remaining, 3200);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      selected.text = item.text.slice(offset, offset + mid); selected.fragment.to = offset + mid;
      if (size() <= cap) low = mid; else high = mid - 1;
    }
    selected.text = item.text.slice(offset, offset + low); selected.fragment.to = offset + low;
    if (size() > cap || low < Math.min(80, remaining)) { evidence.pop(); (delta ? data.deltaIds : data.relatedIds).pop(); return; }
    if (delta) coverage.push({ key: evidenceKey(item), evidenceId: item.id, offset: offset + low });
  }
  // Reserve space for official constraints before selecting incremental messages.
  for (const item of latest.filter(item => item.sourceId === 'project-brief')) add(item, pending.some(value => value.id === item.id), budget * .38);
  // Round-robin sessions, oldest unprocessed first. No fixed session/message-count cutoff.
  const queues = new Map<string, RsiEvidence[]>();
  for (const item of pending) {
    const key = item.sessionId || 'project';
    const queue = queues.get(key) || []; queue.push(item); queues.set(key, queue);
  }
  while ([...queues.values()].some(queue => queue.length)) for (const queue of queues.values()) {
    const item = queue.shift(); if (item) add(item, true, budget * .85);
  }
  const rules = project.policies.find(policy => policy.id === project.activePolicyId)?.rules;
  const rank = (item: RsiEvidence) => rules?.retrieval === 'failures-first' ? Number(/失败|错误|未达标|failure|error/i.test(item.text)) * 100 : rules?.retrieval === 'goal-first' ? Number(item.source === 'project' || item.source === 'configuration') * 100 : 0;
  for (const item of latest.filter(item => !pending.some(value => value.id === item.id)).sort((a, b) => rank(b) - rank(a) || (rules?.retrieval === 'recent' ? b.observedAt.localeCompare(a.observedAt) : relevance(b) - relevance(a)))) add(item, false, budget * .94);
  for (const suggestion of [...project.suggestions].reverse()) {
    if (suggestion.supersededByQuality) continue;
    const current = rsiFeedbackState(suggestion.id, project.events);
    const feedback = [current.decision, current.feedback, current.outcome].filter((event, index, all) => event && all.findIndex(value => value?.id === event.id) === index)
      .map(event => {
        const text = event!.kind === 'outcome' || event!.id === current.feedback?.id ? event!.text : '';
        return { kind: event!.kind, text: text.slice(0, 250), textTruncated: text.length > 250,
          outcome: event!.outcome, feedbackTarget: event!.id === current.feedback?.id ? event!.feedbackTarget : undefined,
          eventId: event!.id, decisionEventId: event!.decisionEventId, at: event!.at };
      });
    data.priorRecommendations.push({ id: suggestion.id, title: suggestion.title, action: suggestion.action.slice(0, 350), closed: current.closed, feedback });
    if (size() > budget) { data.priorRecommendations.pop(); break; }
  }
  const complete = coverage.filter(cursor => latest.find(item => item.id === cursor.evidenceId)?.text.length === cursor.offset).length;
  data.coverage.remainingSources = pending.length - complete;
  data.coverage.partial = data.coverage.remainingSources > 0;
  // Trace indirect inputs too: critiques and prior decisions must be removed with their sources
  // and excluded from held-out learning just like raw messages.
  const visitedRuns = new Set<string>();
  const addRunSources = (runId: string) => {
    if (visitedRuns.has(runId)) return;
    visitedRuns.add(runId);
    const run = project.runs.find(item => item.id === runId); if (!run) return;
    for (const id of [...run.evidenceIds, ...(run.snapshot?.sourceEvidenceIds || [])]) sourceEvidenceIds.add(id);
    if (!run.snapshot) return;
    const old = JSON.parse(run.snapshot.reference);
    for (const id of [...(old.overview?.evidenceIds || []), ...(old.sessions || []).flatMap((item: any) => item.evidenceIds || [])]) sourceEvidenceIds.add(id);
    for (const previous of old.priorRecommendations || []) {
      const suggestion = project.suggestions.find(item => item.id === previous.id); if (suggestion) addRunSources(suggestion.runId);
    }
  };
  for (const prior of data.priorRecommendations) {
    const suggestion = project.suggestions.find(item => item.id === prior.id); if (suggestion) addRunSources(suggestion.runId);
    for (const item of prior.feedback) for (const eventId of [item.eventId, item.decisionEventId]) {
      const event = project.events.find(item => item.id === eventId); if (event) sourceEvidenceIds.add(event.evidenceId);
    }
  }
  for (const item of evidence) sourceEvidenceIds.add(item.id);
  for (const item of data.sessions) for (const id of item.evidenceIds) sourceEvidenceIds.add(id);
  for (const id of data.overview?.evidenceIds || []) sourceEvidenceIds.add(id);
  return { reference: serialize(), evidence, coverage, remaining: data.coverage.remainingSources, sourceEvidenceIds: [...sourceEvidenceIds] };
}

export function applyMemory(project: RsiProject, coverage: RsiCoverage[], answer: RsiAnswer, evidence: RsiEvidence[], at: string) {
  // Validate before changing any cursor, including for direct callers outside the model parser.
  const additions = new Map<string, RsiMemoryEntry>();
  for (const state of answer.sessionStates) {
    if (!state.evidenceIds.every(id => evidence.some(item => item.id === id && item.sessionId === state.sessionId))) throw new Error('会话摘要引用了其他会话或未提供的证据');
    const fragments = [...new Set(state.evidenceIds)].map(id => {
      const item = evidence.find(value => value.id === id)!;
      const fragment = (item as RsiEvidence & { fragment?: { from: number; to: number } }).fragment;
      const from = fragment?.from ?? 0, to = fragment?.to ?? item.text.length;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to - from !== item.text.length) throw new Error('会话摘要的原文片段范围无效');
      return { key: evidenceKey(item), evidenceId: id, from, to };
    }).sort((a, b) => a.key.localeCompare(b.key) || a.from - b.from);
    additions.set(state.sessionId, { id: memoryId(state.sessionId, state.evidenceIds, fragments), summary: structuredClone(state.summary), evidenceIds: [...state.evidenceIds], fragments, updatedAt: at });
  }
  const memory = project.memory ||= emptyMemory();
  const validIds = new Set(latestProjectEvidence(project).map(item => item.id));
  for (const [sessionId, value] of Object.entries(memory.sessions)) {
    const entries = validMemoryEntries(sessionId, value, validIds);
    if (!entries.length) delete memory.sessions[sessionId];
    else {
      const last = entries.at(-1)!;
      memory.sessions[sessionId] = { summary: last.summary, evidenceIds: [...last.evidenceIds], updatedAt: last.updatedAt, entries };
    }
  }
  for (const [sessionId, entry] of additions) {
    const entries = memory.sessions[sessionId]?.entries || [];
    // Re-reading the same raw span must not replace a more useful earlier summary.
    if (containsNewSpan(entry.fragments!, entries)) entries.push(entry);
    if (entries.length) {
      const last = entries.at(-1)!;
      memory.sessions[sessionId] = { summary: last.summary, evidenceIds: [...last.evidenceIds], updatedAt: last.updatedAt, entries };
    }
  }
  for (const cursor of coverage) memory.analyzed[cursor.key] = cursor;
  memory.overview = { state: structuredClone(answer.state), updatedAt: at };
}
