export const humanReadableWritingGuide = `可读性要求：面向没有读过原会话的项目成员，用与材料一致的语言写完整、自然的句子，中文材料默认用中文。
标题点明具体对象和本次经验、观察或问题；不能只写版本号、文件名、内部代号或“整理结果”。正文先说经验要点、观察结果或当前判断，再解释必要依据、适用条件和限制；只有材料支持时才补充下一步，不机械凑齐栏目。
项目经验写清做了什么、观察到什么、在什么条件下可供参考。区分直接观察、原因推测和复用建议；保留反例、未验证范围及证据冲突，不把局部经验写成普遍规律或最终定论。措辞与证据强度一致，可写“在已测试条件下观察到……”；既不把推测说成事实，也不为显得谨慎而模糊已验证的数据。
首次出现的非通用缩写和术语要简短解释，代词要有明确指代。不要把日志、字段名、来源 ID 或零散关键词当作正文，不直接倾倒 JSON、代码或原对话。
每段围绕一个意思，通常一到两句话；并列事项才使用短列表，比较确有必要时使用小表格。来源和技术细节另放来源详情，关键数字、单位、验证范围、未验证状态和分歧必须留在正文。不能为缩短文字而截断句子或删掉影响判断的限制。
提交前按读者视角复核：不看原会话也能理解在说什么、依据是什么、还有什么不确定；若不能，先改写再输出。`;

// Reject unrendered payloads, without pretending to mechanically judge prose quality.
export function assertReadableResultText(text: string, label = '正文') {
  const value = text.trim();
  let structured = false;
  if (/^[\[{]/.test(value)) {
    try { const parsed = JSON.parse(value); structured = parsed !== null && typeof parsed === 'object'; } catch { /* Prose can start with a bracket. */ }
  }
  const fencedOnly = /^```[^\n]*\n(?:(?!```)[\s\S])*\n```$/.test(value);
  const escapedOnly = /^(?:\s|\\u[\da-f]{4}|[，。！？,.!?：:;；])+$/i.test(value) && /(?:\\u[\da-f]{4}){2}/i.test(value);
  if (structured || fencedOnly || escapedOnly) throw new Error(`整理结果的${label}仍是结构化数据、代码或转义文本，请重试并改写为可直接阅读的说明，技术细节放入来源详情。`);
}

const sentences = new Intl.Segmenter('zh-CN', { granularity: 'sentence' });
export function resultPreview(markdown: string, targetLength = 160) {
  const text = markdown.replace(/```[\s\S]*?```/g, '（代码详见正文）').replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:>\s*|[-*+]\s+|\d+\.\s+)/gm, '').replace(/(?:\*\*|__|`)/g, '').replace(/\s+/g, ' ').trim();
  if (text.length <= targetLength) return text;
  let preview = '';
  for (const { segment } of sentences.segment(text)) {
    if (preview && (preview + segment).length > targetLength) break;
    preview += segment;
    if (preview.length >= targetLength) break;
  }
  return preview.trim() + (preview.length < text.length ? ' …' : '');
}
