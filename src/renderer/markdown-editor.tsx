import React from 'react';
import { indentMarkdown } from './markdown-indent';

/** A controlled textarea with native undo and editor-style indentation. */
export function MarkdownEditor({ onKeyDown, ...props }: React.ComponentPropsWithoutRef<'textarea'>) {
  const key = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
  return <span className="markdown-editor">
    <textarea {...props} onKeyDown={key}/>
  </span>;
}
