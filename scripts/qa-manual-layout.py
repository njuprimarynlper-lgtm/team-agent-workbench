"""Render every PDF page and make small contact sheets for visual review."""
from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw
from manual_meta import read_meta

ROOT = Path(__file__).resolve().parents[1]
META = read_meta()
DEFAULT_PDF = ROOT / 'docs/manuals' / f'{META.filename}.pdf'
OUTPUT = ROOT / '.test-data/manual/layout' / f'v{META.version}'


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, default=DEFAULT_PDF)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    bundled = (Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/'
               'native/poppler/Library/bin/pdftoppm.exe')
    poppler = shutil.which('pdftoppm') or (str(bundled) if bundled.exists() else None)
    if not poppler:
        raise RuntimeError('pdftoppm was not found')
    prefix = args.output / 'page'
    for old in (*args.output.glob('page-*.png'), *args.output.glob('contact-*.png')):
        old.unlink()
    subprocess.run([poppler, '-png', '-r', '92', str(args.pdf), str(prefix)], check=True)
    pages = sorted(args.output.glob('page-*.png'))
    if not pages:
        raise RuntimeError('No pages rendered')
    for offset in range(0, len(pages), 8):
        selected = pages[offset:offset + 8]
        sheet = Image.new('RGB', (1680, 1220), '#dfe5e8')
        draw = ImageDraw.Draw(sheet)
        for index, path in enumerate(selected):
            image = Image.open(path).convert('RGB')
            image.thumbnail((390, 555))
            x = 15 + (index % 4) * 415
            y = 35 + (index // 4) * 600
            sheet.paste(image, (x, y))
            draw.text((x, y - 20), f'Page {offset + index + 1}', fill='#102030')
        target = args.output / f'contact-{offset // 8 + 1}.png'
        sheet.save(target)
        print(target)
    print(f'{len(pages)} pages rendered')


if __name__ == '__main__':
    main()
