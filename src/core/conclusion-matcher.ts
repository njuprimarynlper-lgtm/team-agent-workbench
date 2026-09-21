import type { ConclusionMatch, ProjectConclusion } from '../shared/types';

const stopWords = new Set(['一个', '一些', '这个', '那个', '这些', '那些', '什么', '怎么', '如何', '是否', '可以', '需要', '进行', '以及', '或者', '我们', '你们', '他们', '已经', '当前', '相关', '关于', '问题', '项目']);

export function conclusionTokens(value: string) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase().replace(/[`*_>#\[\](){}，。！？；：“”‘’、]/gu, ' ');
  const result: string[] = [];
  for (const token of normalized.match(/[a-z0-9][a-z0-9_.:/-]*/g) || []) if (token.length > 1) result.push(token);
  for (const segment of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    if (segment.length <= 8 && !stopWords.has(segment)) result.push(segment);
    if (segment.length === 1) { if (!stopWords.has(segment)) result.push(segment); continue; }
    for (let i = 0; i < segment.length - 1; i++) {
      const token = segment.slice(i, i + 2); if (!stopWords.has(token)) result.push(token);
    }
  }
  return result;
}

const frequencies = (tokens: string[]) => tokens.reduce<Record<string, number>>((result, token) => { result[token] = (result[token] || 0) + 1; return result; }, {});
const titleTokens = (item: ProjectConclusion, includeAliases = true) => conclusionTokens(item.title + (includeAliases && item.titleAlias ? ' ' + item.titleAlias : ''));
const documentTokens = (item: ProjectConclusion, includeAliases: boolean) => [...titleTokens(item, includeAliases), ...titleTokens(item, includeAliases), ...titleTokens(item, includeAliases), ...conclusionTokens(item.content), ...item.sources.flatMap(source => conclusionTokens(source.title))];

export function rankConclusions(items: ProjectConclusion[], query: string, limit = 8, includeAliases = true): ConclusionMatch[] {
  const active = items.filter(item => !item.archived), queryTokens = [...new Set(conclusionTokens(query))];
  if (!active.length || !queryTokens.length) return [];
  const documents = active.map(item => documentTokens(item, includeAliases)), averageLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / documents.length || 1;
  const documentFrequency = Object.fromEntries(queryTokens.map(token => [token, documents.filter(tokens => tokens.includes(token)).length]));
  const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase();
  return active.map((conclusion, index) => {
    const tokens = documents[index], counts = frequencies(tokens), reasons: string[] = []; let score = 0;
    for (const token of queryTokens) {
      const count = counts[token] || 0; if (!count) continue;
      const idf = Math.log(1 + (active.length - documentFrequency[token] + 0.5) / (documentFrequency[token] + 0.5));
      score += idf * (count * 2.2) / (count + 1.2 * (1 - 0.75 + 0.75 * tokens.length / averageLength));
    }
    const titleHits = [...new Set(titleTokens(conclusion, includeAliases).filter(token => queryTokens.includes(token)))];
    if (titleHits.length) { score += Math.min(3, titleHits.length * 0.75); reasons.push(`标题命中：${titleHits.slice(0, 3).join('、')}`); }
    const exactTechnical = queryTokens.filter(token => /[a-z0-9_.:/-]/.test(token) && conclusionTokens(conclusion.title + ' ' + conclusion.content).includes(token));
    if (exactTechnical.length) { score += Math.min(2, exactTechnical.length); reasons.push(`精确词：${[...new Set(exactTechnical)].slice(0, 3).join('、')}`); }
    if (conclusion.title.length >= 2 && normalizedQuery.includes(conclusion.title.normalize('NFKC').toLocaleLowerCase())) { score += 4; reasons.unshift('直接提到结论标题'); }
    if (includeAliases && conclusion.titleAlias && conclusion.titleAlias.length >= 2 && normalizedQuery.includes(conclusion.titleAlias.normalize('NFKC').toLocaleLowerCase())) { score += 4; reasons.unshift('直接提到结论别名'); }
    if (!reasons.length && score > 0) reasons.push('正文包含相关词');
    return { conclusion, score: Number(score.toFixed(3)), reasons };
  }).filter(item => item.score >= 1.2).sort((a, b) => b.score - a.score || Date.parse(b.conclusion.updatedAt) - Date.parse(a.conclusion.updatedAt)).slice(0, limit);
}
