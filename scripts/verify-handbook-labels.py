"""Check that offline HTML link labels match the headings they open."""
from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / 'docs/handbook/index.html'


class Links(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.current: tuple[str, str, list[str]] | None = None
        self.links: list[tuple[str, str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != 'a':
            return
        values = dict(attrs)
        if 'heading-link' in (values.get('class') or ''):
            return
        href = values.get('href') or ''
        if href.startswith('#'):
            self.current = (href[1:], values.get('class') or '', [])

    def handle_data(self, data: str) -> None:
        if self.current:
            self.current[2].append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == 'a' and self.current:
            target, class_name, parts = self.current
            self.links.append((target, class_name, ''.join(parts).strip()))
            self.current = None


def main() -> None:
    page = HTML.read_text(encoding='utf-8')
    match = re.search(r'<script type="application/json" id="manual-data">(.*?)</script>', page, re.S)
    if not match:
        raise ValueError('Missing embedded manual data')
    articles = json.loads(match.group(1))
    target_ids = [article['id'] for article in articles]
    target_ids.extend(heading['id'] for article in articles for heading in article['headings'])
    if len(target_ids) != len(set(target_ids)):
        raise ValueError('Duplicate article or section destination')
    start = next(article for article in articles if article['id'] == 'start')
    if start['title'] != start['group']:
        raise ValueError('Start-page title differs from its sidebar group')
    structure_match = re.search(r'<script type="application/json" id="manual-structure">(.*?)</script>', page, re.S)
    if not structure_match:
        raise ValueError('Missing navigation structure')
    structure = json.loads(structure_match.group(1))
    ordered_ids = [identifier for group in structure['groups'] for identifier in group['pages']]
    if ordered_ids != [article['id'] for article in articles]:
        raise ValueError('Sidebar and article order differ')
    titles = {article['id']: article['title'] for article in articles}
    titles.update({heading['id']: heading['title'] for article in articles for heading in article['headings']})
    mismatches = []
    total = 0
    for article in articles:
        parser = Links()
        parser.feed(article['html'])
        for target, class_name, label in parser.links:
            total += 1
            expected = titles.get(target)
            normalized = label.removesuffix('→').strip()
            matched = expected is not None and (expected in label if 'role-card' in class_name else normalized == expected)
            if not matched:
                mismatches.append((article['id'], target, label, expected))
    if mismatches:
        for article, target, label, expected in mismatches:
            print(f'{article}: [{label}](#{target}) -> {expected}')
        raise SystemExit(f'{len(mismatches)} inconsistent HTML links')
    print(f'HTML labels match destinations: {total} links, {len(titles)} headings')


if __name__ == '__main__':
    main()
