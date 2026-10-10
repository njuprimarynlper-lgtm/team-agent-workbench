"""Keep an idempotent, visible Git baseline history for HTML handbook edits."""
from __future__ import annotations

import hashlib
import html
import json
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "docs" / "handbook" / "revisions.json"
PANEL = re.compile(
    r'<span class="revision-stamp">.*?</span><details class="revision-history">.*?</details>',
    re.S,
)


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True, encoding="utf-8").strip()


def committed_source(commit: str) -> str:
    """Preserve HTML whitespace so its fingerprint matches the saved source."""
    return subprocess.check_output(
        ["git", "show", f"{commit}:docs/handbook/index.html"],
        cwd=ROOT, text=True, encoding="utf-8",
    )


def content_without_history(source: str) -> str:
    return PANEL.sub("", source)


def fingerprint(source: str) -> str:
    return hashlib.sha256(content_without_history(source).encode("utf-8")).hexdigest()


def historical_revisions() -> list[dict]:
    """Seed only Git commits that actually changed the handbook HTML."""
    lines = git("log", "--format=%H%x1f%cI%x1f%s", "--", "docs/handbook/index.html").splitlines()
    entries = []
    for line in reversed(lines):
        commit, updated_at, summary = line.split("\x1f", 2)
        source = committed_source(commit)
        entries.append({
            "updated_at": updated_at,
            "base_commit": commit,
            "document_commit": commit,
            "summary": summary,
            "content_sha256": fingerprint(source),
        })
    return entries


def read_log() -> dict:
    if LOG.exists():
        data = json.loads(LOG.read_text(encoding="utf-8"))
        if data.get("schema") != 1 or not isinstance(data.get("revisions"), list):
            raise ValueError(f"Invalid handbook revision log: {LOG}")
        return data
    return {"schema": 1, "revisions": historical_revisions()}


def finalize_committed_revisions(entries: list[dict]) -> bool:
    """Fill a pending document commit after its exact HTML is committed later."""
    pending = {entry["content_sha256"]: entry for entry in entries if not entry.get("document_commit")}
    if not pending:
        return False
    changed = False
    for commit in git("log", "--format=%H", "--", "docs/handbook/index.html").splitlines():
        digest = fingerprint(committed_source(commit))
        if digest in pending:
            pending[digest]["document_commit"] = commit
            del pending[digest]
            changed = True
        if not pending:
            break
    return changed


def render_history(entries: list[dict]) -> str:
    latest = entries[-1]
    current = html.escape(latest["base_commit"])
    items = []
    for entry in reversed(entries):
        moment = html.escape(entry["updated_at"].replace("T", " ")[:19])
        summary = html.escape(entry["summary"])
        commit = html.escape(entry["base_commit"])
        document_commit = entry.get("document_commit")
        state = (
            f'文档内容提交：<code>{html.escape(document_commit)}</code>'
            if document_commit else "编辑时仓库 HEAD；文档改动尚未提交"
        )
        items.append(
            f'<li><span>{moment} · {summary}</span>'
            f'<code title="完整 Git commit ID">{commit}</code><small>{state}</small></li>'
        )
    return (
        f'<span class="revision-stamp">文档编辑基线 <code title="编辑时仓库 HEAD：{current}">{current[:7]}</code></span>'
        f'<details class="revision-history"><summary>文档更新记录（{len(entries)}）</summary>'
        f'<ol>{"".join(items)}</ol></details>'
    )


def record_and_embed(source: str, summary: str) -> str:
    """Append a revision only when the handbook body actually changed."""
    clean = content_without_history(source)
    if "</footer></main>" not in clean:
        raise ValueError("Handbook footer not found")
    digest = fingerprint(clean)
    data = read_log()
    revisions = data["revisions"]
    changed = finalize_committed_revisions(revisions)
    if not revisions or revisions[-1]["content_sha256"] != digest:
        revisions.append({
            "updated_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
            "base_commit": git("rev-parse", "HEAD"),
            "document_commit": None,
            "summary": summary.strip() or "更新 HTML 手册",
            "content_sha256": digest,
        })
        changed = True
    if changed:
        LOG.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return clean.replace("</footer></main>", render_history(revisions) + "</footer></main>", 1)
