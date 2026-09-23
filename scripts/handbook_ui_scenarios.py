"""Render reusable, code-checked interface walkthroughs into the HTML handbook.

Only the generated HTML is changed. Scenario copy lives in
docs/handbook/ui-scenarios.json so future handbook refreshes keep the diagrams.
"""
from __future__ import annotations

import html
import json
import re
import base64
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "docs" / "handbook"
DATA = WEB / "ui-scenarios.json"
HTML = WEB / "index.html"
SCREENS = WEB / "ui-screens"


def escape(value: str) -> str:
    return html.escape(value, quote=True)


def render_pane(pane: dict, identifier: str, step_number: int, pane_number: int) -> str:
    file = SCREENS / f"{identifier}-{step_number:02d}-{pane_number}.png"
    if not file.exists():
        raise ValueError(f"Missing screenshot-style illustration: {file}")
    data = base64.b64encode(file.read_bytes()).decode("ascii")
    label = f'{pane["actor"]}：{pane["screen"]}'
    return (
        '<div class="ui-person-pane ui-screen-shot">'
        f'<div class="ui-person-label">{escape(label)}</div>'
        f'<button class="zoom-image" type="button" aria-label="放大查看{escape(label)}">'
        f'<img src="data:image/png;base64,{data}" alt="{escape(label)}的工作台界面示意" loading="lazy">'
        '<span>点击放大</span></button></div>'
    )


def render_guide(spec: dict, identifier: str) -> str:
    steps = []
    for number, step in enumerate(spec["steps"], 1):
        panes = "".join(render_pane(pane, identifier, number, index) for index, pane in enumerate(step["panes"], 1))
        steps.append(
            '<li class="ui-scenario-step">'
            '<div class="ui-scenario-step-head">'
            f'<span class="ui-scenario-number">{number:02d}</span>'
            f'<h3>{escape(step["title"])}</h3></div>'
            f'<div class="ui-screen-pair">{panes}</div>'
            f'<p class="ui-scenario-handoff"><strong>双方看到的变化</strong>{escape(step["handoff"])}</p>'
            '</li>'
        )
    return (
        f'<figure class="ui-scenario-guide" aria-label="{escape(spec["caption"])}">'
        f'<figcaption>{escape(spec["caption"])}</figcaption>'
        '<p class="ui-scenario-note">截图式界面示意：按当前工作台布局与按钮绘制，任务名称和内容为说明样例。'
        '点击图片放大；对方的变化在同步或刷新后显示。</p>'
        f'<ol class="ui-scenario-list">{"".join(steps)}</ol>'
        '</figure>'
    )


def search_text(spec: dict) -> str:
    return " ".join(
        [spec["caption"]] + [
            " ".join(
                [step["title"], step["handoff"]] + [
                    " ".join([pane["actor"], pane["screen"], pane["status"], pane["action"]]
                             + [text for row in pane["rows"] for text in row])
                    for pane in step["panes"]
                ]
            )
            for step in spec["steps"]
        ]
    )


def enhance_html(path: Path = HTML) -> None:
    subprocess.run(["node", str(ROOT / "scripts" / "render_handbook_ui_screens.mjs")], cwd=ROOT, check=True)
    source = path.read_text(encoding="utf-8")
    source, css_count = re.subn(
        r"(<style>).*?(</style>)",
        lambda match: match.group(1) + (WEB / "handbook.css").read_text(encoding="utf-8") + match.group(2),
        source,
        count=1,
        flags=re.S,
    )
    if css_count != 1:
        raise ValueError("Handbook inline style not found")
    match = re.search(r'(<script type="application/json" id="manual-data">)(.*?)(</script>)', source, re.S)
    if not match:
        raise ValueError("Handbook article data not found")
    articles = json.loads(match.group(2))
    scenarios = json.loads(DATA.read_text(encoding="utf-8"))
    if set(scenarios) != {"example", "case-new-member", "case-egress-mixed"}:
        raise ValueError("Expected exactly the three use-case guides")
    changed = set()
    for article in articles:
        identifier = article["id"]
        if identifier not in scenarios:
            continue
        spec = scenarios[identifier]
        if not spec["steps"] or any(len(step["panes"]) != 2 for step in spec["steps"]):
            raise ValueError(f"Every {identifier} step needs two interface panels")
        old = article["html"]
        pattern = r'<figure class="(?:case-diagram|ui-scenario-guide)".*?</figure>'
        updated, count = re.subn(pattern, lambda _: render_guide(spec, identifier), old, count=1, flags=re.S)
        if count != 1:
            raise ValueError(f"Missing old diagram in {identifier}")
        article["html"] = updated
        previous = article.get("uiScenarioSearchText", "")
        if previous:
            article["text"] = article["text"].replace(previous, "").rstrip()
        current = search_text(spec)
        article["text"] += " " + current
        article["uiScenarioSearchText"] = current
        target = "example-walkthrough" if identifier == "example" else identifier + "-steps"
        for section in article["sections"]:
            if section["id"] == target:
                if previous:
                    section["text"] = section["text"].replace(previous, "").rstrip()
                section["text"] += " " + current
                break
        else:
            raise ValueError(f"Missing walkthrough section in {identifier}")
        changed.add(identifier)
    if changed != set(scenarios):
        raise ValueError(f"Missing scenario articles: {set(scenarios) - changed}")
    data = json.dumps(articles, ensure_ascii=False).replace("</", r"<\/")
    source = source[:match.start(2)] + data + source[match.end(2):]
    path.write_text(source, encoding="utf-8")


if __name__ == "__main__":
    enhance_html()
    print(f"Updated three interface walkthroughs in {HTML}")
