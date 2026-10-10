"""Shared screenshot callouts for capture, HTML captions, and future refreshes."""
import html
import json
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GUIDES = json.loads((ROOT / 'docs/handbook/screenshot-guides.json').read_text(encoding='utf-8'))
SCREENS = ROOT / 'docs/handbook/ui-screens'
CAPTURES = {item['file']: item for item in json.loads((SCREENS / 'manifest.json').read_text(encoding='utf-8'))['captures']}


def screenshot_caption(filename):
    guide = GUIDES[filename]
    capture = CAPTURES[filename]
    signature = hashlib.sha256(json.dumps(guide, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
    assert capture.get('guide_sha256') == signature, f'Screenshot guide changed; refresh capture: {filename}'
    assert capture.get('image_sha256') == hashlib.sha256((SCREENS / filename).read_bytes()).hexdigest(), f'Screenshot differs from reviewed capture: {filename}'
    kind = guide.get('kind')
    title = html.escape(guide['purpose'], quote=True)
    if kind == 'display':
        assert guide.get('explanation'), f'Display screenshot needs an explanation: {filename}'
        content = '<p>' + html.escape(guide['explanation']) + '</p>'
    else:
        assert kind == 'instruction' and guide.get('callouts'), f'Missing screenshot callouts: {filename}'
        items = ''.join(
            f'<li><span class="screenshot-number">{i}</span><span>{html.escape(item["text"])}</span></li>'
            for i, item in enumerate(guide['callouts'], 1)
            if item.get('show_caption', True)
        )
        content = '<ol>' + items + '</ol>' if items else ''
    return f'<div class="screenshot-caption" data-screenshot="{html.escape(filename)}" data-kind="{kind}" aria-label="{title}">{content}</div>'


def screenshot_search(filename):
    guide = GUIDES[filename]
    return ' '.join([guide['purpose'], guide.get('explanation', ''), *(
        item['text'] if item.get('show_caption', True) else item.get('button', item.get('field', ''))
        for item in guide.get('callouts', [])
    )])
