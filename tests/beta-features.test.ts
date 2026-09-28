import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BetaFeaturesModal, betaFeatureStates } from '../src/renderer/beta-features';

test('legacy combined Beta choice remains enabled for both abilities', () => {
  assert.deepEqual(betaFeatureStates({ sessionHandoff: true }), { sessionHandoff: true, subsessions: true });
  assert.deepEqual(betaFeatureStates({ sessionHandoff: true, subsessions: false }), { sessionHandoff: true, subsessions: false });
  assert.deepEqual(betaFeatureStates({ sessionHandoff: false, subsessions: true }), { sessionHandoff: false, subsessions: true });
});

test('the Beta dialog shows independent switches', () => {
  const html = renderToStaticMarkup(React.createElement(BetaFeaturesModal, { features: { sessionHandoff: true, subsessions: false }, close: () => {}, changed: async () => {} }));
  assert.equal((html.match(/role="switch"/g) || []).length, 2);
  assert.match(html, /aria-label="开启跨会话引用" checked=""/);
  assert.doesNotMatch(html, /aria-label="开启 Subsession" checked=""/);
  assert.match(html, /关闭后不能新建 Subsession 或回报/);
});
