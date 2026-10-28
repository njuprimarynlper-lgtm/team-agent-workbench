import { z } from 'zod';

export const rsiExecutionSchema = z.object({
  provider: z.enum(['codex', 'cursor', 'claude']), model: z.string().trim().max(200).default(''),
  reasoningEffort: z.string().max(80).optional(), networkRoute: z.enum(['direct', 'management']).default('direct'),
}).strict();
export type RsiExecution = z.infer<typeof rsiExecutionSchema>;
export const rsiConfigSchema = z.object({
  enabled: z.boolean().default(true), autoLearn: z.boolean().default(false),
  contextChars: z.number().int().min(2000).max(24000).default(12000),
  execution: rsiExecutionSchema.optional(),
  role: z.string().trim().max(2000).default(''), preference: z.string().trim().max(2000).default(''),
  goals: z.string().trim().max(6000).default(''), acceptance: z.string().trim().max(6000).default(''),
  quiet: z.boolean().default(false),
});
export type RsiConfig = z.infer<typeof rsiConfigSchema>;
export const rsiShadowSettingsSchema = z.object({ enabled: z.boolean().optional(), execution: rsiExecutionSchema.optional() }).strict();
export interface RsiShadowSettings {
  config: RsiConfig;
  cwd?: string;
  sourceSession?: { title: string; provider: string; model?: string };
}
export const rsiPolicySchema = z.object({
  guidance: z.string().trim().min(1).max(6000),
  cooldownMinutes: z.number().int().min(0).max(1440),
  maxSuggestions: z.number().int().min(1).max(3),
  retrieval: z.enum(['recent', 'goal-first', 'failures-first']),
}).strict();
export type RsiPolicyRules = z.infer<typeof rsiPolicySchema>;
export const rsiDefaultRules: RsiPolicyRules = {
  guidance: '依据当前进展判断用户是否确实需要帮助，再提供现有工作中缺少的有效增量。正常探索和未完成的任务不自动构成困境。区分事实、意图和推断；查证须说明它解开哪个判断。标题与正文独立可理解，没有新依据或帮助价值时不推荐。',
  cooldownMinutes: 10, maxSuggestions: 2, retrieval: 'goal-first',
};
export type RsiSource = 'session' | 'interface' | 'project' | 'execution' | 'evaluation' | 'configuration';
export interface RsiScope { key: string; account: string; projectId: string; user: string }
export interface RsiEvidence {
  id: string; scope: string; source: RsiSource; sourceId: string; factKey: string;
  eventAt: string; observedAt: string; version: string; text: string; hash: string;
  assertion: 'explicit' | 'observed' | 'inferred'; actor: string; sessionId?: string;
  suggestionId?: string; taskId?: string; artifact?: string;
  sessionTitle?: string; messageId?: string; turnId?: string; sequence?: number; nativeSessionId?: string;
  contentType?: string; supersedes?: string;
}
export type RsiObservation = Omit<RsiEvidence, 'id' | 'scope' | 'observedAt' | 'hash'>;
export const rsiSuggestionSchema = z.object({
  title: z.string().trim().min(1).max(180), action: z.string().trim().min(1).max(1200), reason: z.string().trim().min(1).max(2000),
  evidenceIds: z.array(z.string()).min(1), conditions: z.array(z.string()), uncertainty: z.string(),
  priority: z.number().min(0).max(1),
}).strict();
export const rsiSessionSummarySchema = z.union([
  z.string().max(1200), // Persisted legacy prompts still produce text summaries.
  z.object({
    constraints: z.array(z.string()), observations: z.array(z.string()),
    decisions: z.array(z.string()), openQuestions: z.array(z.string()),
  }).strict().refine(value => JSON.stringify(value).length <= 1200, '会话摘要不能超过 1200 字符'),
]);
export const rsiAnswerSchema = z.object({
  state: z.object({ progress: z.string(), blockers: z.array(z.string()), unknowns: z.array(z.string()), evidenceIds: z.array(z.string()) }).strict(),
  suggestions: z.array(rsiSuggestionSchema),
  sessionStates: z.array(z.object({ sessionId: z.string(), summary: rsiSessionSummarySchema, evidenceIds: z.array(z.string()).min(1) }).strict()).default([]),
}).strict();
export type RsiAnswer = z.infer<typeof rsiAnswerSchema>;
export const rsiValueGateSchema = z.object({
  status: z.enum(['pass', 'fail', 'unknown', 'not_evaluated']),
  reason: z.string().trim().min(1).max(600),
  evidenceIds: z.array(z.string()).max(12), counterEvidenceIds: z.array(z.string()).max(12),
  support: z.array(z.object({ evidenceId: z.string(), quote: z.string().trim().min(1).max(600), explains: z.string().trim().min(1).max(400) }).strict()).max(12),
  counterSupport: z.array(z.object({ evidenceId: z.string(), quote: z.string().trim().min(1).max(600), explains: z.string().trim().min(1).max(400) }).strict()).max(12),
}).strict();
export const rsiPresentationSchema = z.object({
  status: z.enum(['pass', 'fail', 'unknown']),
  problem: z.string().trim().max(400), action: z.string().trim().max(400), benefit: z.string().trim().max(400),
  reason: z.string().trim().min(1).max(600), correction: z.string().trim().max(600),
}).strict();
export const rsiValueVerdictSchema = z.object({
  candidateId: z.string(), difficulty: rsiValueGateSchema, need: rsiValueGateSchema, benefit: rsiValueGateSchema,
  currentProgress: z.string().trim().min(1).max(600), missingHelp: z.string().trim().min(1).max(600),
  correction: z.string().trim().min(1).max(600), reconsiderWhen: z.string().trim().min(1).max(400),
}).strict();
export type RsiValueVerdict = z.infer<typeof rsiValueVerdictSchema> & { presentation?: z.infer<typeof rsiPresentationSchema> };
export interface RsiValueCandidate { candidateId: string; suggestion: RsiAnswer['suggestions'][number] }
export interface RsiValueAttempt {
  round: number; purpose: 'judge' | 'revise' | 'presentation'; referenceHash?: string; promptHash: string;
  candidates: RsiValueCandidate[]; output?: string; verdicts?: RsiValueVerdict[]; error?: string;
}
/** Machine critique is separate from project facts, explicit user feedback and learned policies. */
export interface RsiValueFeedback {
  runId: string; candidateId: string; at: string; title: string; action: string;
  evidenceIds: string[]; configHash: string; verdict: RsiValueVerdict;
}
export interface RsiSuggestion extends z.infer<typeof rsiSuggestionSchema> {
  id: string; runId: string; policyId: string; createdAt: string; fingerprint: string;
  sessionId: string; projectId: string;
  supersededByQuality?: string;
}
export const rsiReactionSchema = z.object({
  suggestionId: z.string(), kind: z.enum(['presented', 'visible', 'accepted', 'rejected', 'dismissed', 'reopened', 'supplement', 'deferred', 'edited', 'feedback', 'action', 'outcome']),
  text: z.string().trim().max(6000).default(''), requestId: z.string().min(1).max(160),
  linkedSessionId: z.string().min(1).nullable().optional(),
  expectedDecisionId: z.string().min(1).nullable().optional(),
  feedbackTarget: z.literal('recommendation').optional(),
  outcome: z.enum(['success', 'failure', 'rework', 'unknown']).optional(),
}).strict();
export type RsiReaction = z.infer<typeof rsiReactionSchema>;
export interface RsiEvent extends RsiReaction { id: string; at: string; actor: string; evidenceId: string; decisionEventId?: string }
export interface RsiRun {
  id: string; at: string; policyId: string; model: string; provider: string; route: string;
  trigger: string; inputHash: string; evidenceIds: string[]; inputChars: number;
  finishedAt?: string; durationMs?: number;
  status: 'running' | 'completed' | 'error' | 'interrupted'; error?: string;
  decision?: string; state?: RsiAnswer['state']; suggestions: string[]; output?: string;
  valueReview?: { contract: 'value-v1' | 'value-v2'; referenceHash: string; attempts: RsiValueAttempt[] };
  snapshot?: { sourceEvidenceIds?: string[]; capturedAt: string; revision: number; policyHash: string; evidence: RsiEvidence[]; delta: RsiCoverage[]; reference: string; configHash: string; prompt?: string };
}
export interface RsiPolicy {
  id: string; createdAt: string; rules: RsiPolicyRules; baseId?: string;
  hypothesis: string; evidenceIds: string[]; status: 'active' | 'candidate' | 'retired';
  scope: 'user-project' | 'project' | 'personal' | 'general';
  familyId?: string; origin?: { projectId: string; policyId: string };
  heldOutCaseIds?: string[];
  sourceEvidenceIds?: string[];
  feedbackEvidenceIds?: string[];
  feedbackDecisions?: Record<string, string | null>;
  learningInputHash?: string;
  bundle?: { contract: 1; context: 'project-incremental-v1'; evaluator: 'heldout-v1'; promptFormat?: 'structured-v2'; prompt: string };
}
export const rsiCaseSchema = z.object({
  name: z.string().trim().min(1).max(180), evidenceIds: z.array(z.string()).min(1).max(60),
  cutoff: z.string().datetime(), shouldSuggest: z.boolean(),
  required: z.array(z.string().trim().min(1)).max(12), forbidden: z.array(z.string().trim().min(1)).max(12),
}).strict();
export interface RsiCase extends z.infer<typeof rsiCaseSchema> { id: string; createdAt: string; evidence: RsiEvidence[]; config: RsiConfig; author: string }
export interface RsiScore { quality: number; omissions: number; interruptions: number; violations: number; chars: number }
export interface RsiEvaluation {
  id: string; at: string; candidateId: string; baselineId: string; model: string;
  projectRevision: number;
  caseIds: string[]; baseline: RsiScore; candidate: RsiScore;
  passed: boolean; reasons: string[]; outputs: { caseId: string; baseline: RsiAnswer; candidate: RsiAnswer }[];
  contract?: number;
  valueReviewContract?: 'value-v1' | 'value-v2';
  policyHash?: string;
  qualityReview?: { approved: boolean; reason: string; actor: string; at: string };
}
export interface RsiRelease { id: string; at: string; from: string; to: string; actor: string; evaluationId?: string; reason: string }
export interface RsiProject {
  scope: RsiScope; config: RsiConfig; revision: number; evidence: RsiEvidence[];
  settingsConfigured?: true;
  events: RsiEvent[]; suggestions: RsiSuggestion[]; runs: RsiRun[]; policies: RsiPolicy[];
  activePolicyId: string; cases: RsiCase[]; evaluations: RsiEvaluation[]; releases: RsiRelease[];
  calls: { at: string; purpose: string; model: string }[]; lastError?: string;
  memory?: RsiMemory;
  valueFeedback?: RsiValueFeedback[];
  qualityRefreshPending?: boolean;
  learningRuns?: { inputHash: string; baseId: string; model: string; at: string; evidenceIds: string[]; feedbackIds: string[];
    prompt: string; outcome: 'candidate' | 'unchanged'; hypothesis: string; candidateId?: string }[];
  pending?: { recommendation?: { trigger: string; dueAt: number }; learning?: { dueAt: number } };
}
export interface RsiCoverage { key: string; evidenceId: string; offset: number }
export interface RsiMemoryEntry {
  id: string;
  summary: z.infer<typeof rsiSessionSummarySchema>;
  evidenceIds: string[];
  /** Absent for legacy summaries whose exact source spans were not recorded. */
  fragments?: { key: string; evidenceId: string; from: number; to: number }[];
  updatedAt: string;
}
export interface RsiMemory {
  analyzed: Record<string, RsiCoverage>;
  sessions: Record<string, { summary: z.infer<typeof rsiSessionSummarySchema>; evidenceIds: string[]; updatedAt: string; entries?: RsiMemoryEntry[] }>;
  overview?: { state: RsiAnswer['state']; updatedAt: string };
}
export interface RsiView extends RsiProject {
  busy: boolean; stage?: string; queued: boolean; personalPreference: string;
  sourceSession?: { id: string; title: string; provider: string; model?: string; reasoningEffort?: string };
  reusablePolicies: { projectId: string; policyId: string; guidance: string; validatedProjects: number }[];
}

/** One current decision episode; replaced feedback stays in the ledger, not in learning votes. */
export function rsiFeedbackState(suggestionId: string, events: RsiEvent[]) {
  const own = events.filter(event => event.suggestionId === suggestionId);
  const decision = own.filter(event => event.kind === 'accepted' || event.kind === 'rejected').at(-1);
  const episode = decision ? own.slice(own.indexOf(decision)) : own;
  const currentEpisode = episode.filter(event => !event.decisionEventId || event.decisionEventId === decision?.id);
  const feedback = currentEpisode.filter(event => ['supplement', 'feedback', 'accepted', 'rejected'].includes(event.kind)).at(-1);
  const supplement = currentEpisode.filter(event => event.kind === 'supplement').at(-1);
  const outcome = own.filter(event => event.kind === 'outcome').at(-1);
  // Saving the optional supplement completes this review in the same durable
  // event. A new decision starts a new review; an explicit reopen still wins.
  const closure = own.filter(event => event.kind === 'dismissed' || event.kind === 'reopened' || event.kind === 'supplement' && currentEpisode.includes(event)).at(-1);
  const closed = closure?.kind === 'dismissed' || closure?.kind === 'supplement';
  return { decision, feedback, supplement, outcome, closed };
}
export interface RsiReview {
  decision: 'pending' | 'accepted' | 'rejected'; closed: boolean;
  linkedSessionId?: string; feedback: string; feedbackTarget?: 'recommendation'; decisionEventId?: string;
}
export function rsiReview(suggestionId: string, events: RsiEvent[]) {
  const { decision, feedback, supplement, closed } = rsiFeedbackState(suggestionId, events);
  return { decision: decision?.kind || 'pending', closed, decisionEventId: decision?.id,
    linkedSessionId: decision?.kind === 'accepted' ? supplement?.linkedSessionId || undefined : undefined,
    feedback: feedback?.text || '', ...(feedback?.feedbackTarget ? { feedbackTarget: feedback.feedbackTarget } : {}) } as RsiReview;
}
export interface RsiInbox {
  projectId: string; enabled: boolean; busy: boolean; queued: boolean; lastError?: string;
  sessions: { id: string; title: string }[];
  items: (RsiSuggestion & { review: ReturnType<typeof rsiReview>; evidence: Pick<RsiEvidence, 'id' | 'source' | 'text' | 'eventAt'>[] })[];
}

export function rsiSuggestionState(suggestion: RsiSuggestion, events: RsiEvent[]) {
  const reactions = events.filter(event => event.suggestionId === suggestion.id);
  const outcome = reactions.filter(event => event.kind === 'outcome').at(-1);
  if (outcome) return outcome.outcome === 'success' ? '已确认有效' : outcome.outcome === 'failure' ? '执行未达标' : outcome.outcome === 'rework' ? '需要返工' : '结果待确认';
  const intent = reactions.filter(event => ['accepted', 'rejected', 'dismissed', 'deferred', 'edited', 'action'].includes(event.kind)).at(-1);
  return intent ? ({ accepted: '已接受，效果待验证', rejected: '已拒绝', dismissed: '已关闭', deferred: '已延后', edited: '已修改', action: '已执行，结果待确认' } as Record<string, string>)[intent.kind] : '待判断';
}
