"""Package the offline handbook and editable/printable editions for distribution."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import re
import sys
from manual_meta import PACKAGE_MARKDOWN, read_meta

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
META = read_meta()
NAME = META.filename
FILES = PACKAGE_MARKDOWN
REPO = META.repository_url


def markdown_for_package(name):
    """Keep included links local; point other repository references at the snapshot."""
    def link(match):
        label, target = match.groups()
        if target.startswith(('#', 'https://', 'http://', 'mailto:')):
            return match[0]
        filename, _, fragment = target.partition('#')
        if filename in FILES or filename.startswith('images/user-manual/'):
            return match[0]
        resolved = (DOCS / filename).resolve()
        try:
            relative = resolved.relative_to(ROOT).as_posix()
        except ValueError:
            raise ValueError(f'Link outside repository in {name}: {target}')
        return f'[{label}]({REPO}{relative}' + (f'#{fragment}' if fragment else '') + ')'
    return re.sub(r'\[([^\]]+)\]\(([^)]+)\)', link, (DOCS / name).read_text(encoding='utf-8'))


def main():
    handbook = (DOCS / 'handbook/index.html').read_text(encoding='utf-8')
    handbook = handbook.replace('../manuals/', '').replace('../user-guide.md', 'Markdown/user-guide.md')
    output = DOCS / 'manuals' / f'{NAME}.zip'
    with ZipFile(output, 'w', ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr('使用手册.html', handbook)
        archive.writestr('先读我.txt',
            f'团队工作台使用手册 {META.version}\n\n'
            '1. 请先解压整个压缩包，再双击“使用手册.html”。\n'
            '2. 按角色或任务进入，用页面顶部搜索查找操作，点击配图可放大。\n'
            '3. 右上角“其他格式”可打开 Word、PDF 或 Markdown。\n'
            '4. 网页正文、搜索、配图和部署指导均可离线使用；官网和仓库外链需要联网。\n'
            '5. Word 和 PDF 提供可点击的任务导航及页脚返回入口。Word 按默认设置可能需要 Ctrl+单击。\n'
            '6. 使用手册与部署指导分开；部署指导位于网页目录“部署与运维”中。\n\n'
            f'文档适用版本：{META.software_version} / {META.commit}。\n')
        for ext in ['docx', 'pdf']:
            source = DOCS / 'manuals' / f'{NAME}.{ext}'
            archive.write(source, source.name)
        for name in FILES:
            archive.writestr('Markdown/' + name, markdown_for_package(name))
        referenced_images = set(re.findall(r'!\[[^\]]*\]\((images/user-manual/[^)]+)\)',
                                           (DOCS / 'user-guide.md').read_text(encoding='utf-8')))
        for relative in sorted(referenced_images):
            archive.write(DOCS / relative, 'Markdown/' + relative)
    with ZipFile(output) as archive:
        assert archive.testzip() is None
    print(f'Packaged {output} ({output.stat().st_size:,} bytes)')


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    main()
