import React, { useRef, useState } from 'react';
import { Markdown } from './markdown';
import { indentMarkdown } from './markdown-indent';

/** A controlled textarea with native undo, Markdown preview and editor-style indentation. */
export function MarkdownEditor({ onKeyDown, ...props }: React.ComponentPropsWithoutRef<'textarea'>) {
  const input = useRef<HTMLTextAreaElement>(null), [preview, setPreview] = useState(false);
  const label = props['aria-label'] || '内容';
  const key = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'm' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); input.current?.parentElement?.querySelector('button')?.focus(); return; }
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !props.readOnly && !event.defaultPrevented) {
      event.preventDefault(); event.stopPropagation();
      const element = event.currentTarget, edit = indentMarkdown(element.value, element.selectionStart, element.selectionEnd, event.shiftKey);
      if (props.maxLength !== undefined && element.value.length + edit.text.length - (edit.to - edit.from) > props.maxLength) return;
      if (element.value.slice(edit.from, edit.to) !== edit.text) {
        const before = element.value;
        element.setSelectionRange(edit.from, edit.to);
        // Chromium's insertText keeps edits on the same undo stack as typing.
        document.execCommand('insertText', false, edit.text);
        if (element.value === before) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, before.slice(0, edit.from) + edit.text + before.slice(edit.to));
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      element.setSelectionRange(edit.start, edit.end);
      return;
    }
    onKeyDown?.(event);
  };
  return <span className={'markdown-editor' + (preview ? ' is-preview' : '')}>
    <textarea {...props} ref={input} hidden={preview} onKeyDown={key}/>
    {preview && <span className="markdown-editor-preview" role="region" aria-label={`${label} Markdown 预览`} style={{ minHeight: props.style?.height || Math.max(3, props.rows || 3) * 22 }}><Markdown text={String(props.value ?? props.defaultValue ?? '') || '暂无内容'}/></span>}
    <span className="markdown-editor-tools"><span title="Tab 缩进，Shift+Tab 反缩进；Ctrl+M 可移到预览按钮">Markdown · Tab 缩进</span><button type="button" className="text-button" aria-label={preview ? '编辑 Markdown' : '预览 Markdown'} title={`${label} · ${preview ? '编辑' : '预览'}`} aria-pressed={preview} onClick={event => { event.preventDefault(); setPreview(!preview); if (preview) requestAnimationFrame(() => input.current?.focus()); }}>{preview ? '编辑' : '预览'}</button></span>
  </span>;
}
