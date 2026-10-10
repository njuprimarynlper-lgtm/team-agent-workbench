"""Keep HTML path examples portable without changing the Markdown deliverables."""
import re
from html.parser import HTMLParser


class _VisibleText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, attrs):
        self.parts.extend(value for key, value in attrs if value and key in ('alt', 'title', 'aria-label', 'placeholder'))


def assert_portable_paths(articles):
    """Reject machine-specific paths in rendered text and the search index."""
    absolute = re.compile(r'(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|/(?:srv|opt|etc|home|var|tmp|run|usr)(?:/|\b))')
    for article in articles:
        visible = _VisibleText()
        visible.feed(article['html'])
        text = ' '.join([*visible.parts, article.get('text', ''), *(section.get('text', '') for section in article.get('sections', []))])
        match = absolute.search(text)
        if match:
            raise ValueError(f"Absolute filesystem path in handbook article {article['id']}: {text[match.start():match.start()+100]}")


def document_paths(source: str) -> str:
    replacements = {
        'images/user-manual/deployment-logic.png': 'handbook/diagrams/deployment-logic.png',
        'images/user-manual/task-lifecycle.png': 'handbook/diagrams/task-lifecycle.png',
        'images/user-manual/reference-flow.png': 'handbook/diagrams/reference-flow.png',
        'images/user-manual/publish-flow.png': 'handbook/diagrams/publish-flow.png',
        'images/user-manual/sync-scope.png': 'handbook/diagrams/sync-scope.png',
        '准备一个专用空目录作为共享区，例如 `D:\\TeamAgentDemo\\shared`。': '在选定的联调目录内创建专用空目录 `shared/`，作为共享区。',
        '现有联调环境：`D:\\agent开发\\比赛协同联调\\run-20260916-02`。': '联调入口位于各自的联调目录中：',
        '`D:\\agent开发\\team-agent-workbench\\dist/user`': '仓库根目录下的 `dist/user`',
        '规划团队根目录，例如 `/srv/teamspace`': '选择专用目录作为团队根目录',
        '在服务器专用目录（例如 `/opt/workbench-packages`）': '在选定的服务器离线包目录中',
        '服务器专用目录（例如 `/opt/workbench-packages`）': '选定的服务器离线包目录',
        '`/etc/': '`etc/',
        '`/var/run`': '`var/run`',
        '`/run`': '`run`',
        '账号登记位于 `<团队根路径>/.workbench/admin/state.json`': '以团队根目录为基准，账号登记位于 `.workbench/admin/state.json`',
        '`<团队根路径>/.workbench/roles.json`': '`.workbench/roles.json`',
        '### 在线与离线准备环境\n': '### 在线与离线准备环境\n\n下文的系统配置文件以服务器文件系统根目录为基准列出相对位置，例如 `etc/team-agent-workbench/`。在服务器上定位到对应目录后执行操作。\n',
    }
    for old, new in replacements.items():
        source = source.replace(old, new)
    return source
