import React from 'react';
import { CodexComposerTools, type ComposerToolProps } from './composer-codex-tools';

export function ComposerCapabilities(props: ComposerToolProps) {
  if (props.session.cursorNative) return null;
  return <CodexComposerTools {...props}/>;
}
