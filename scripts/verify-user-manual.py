"""Check manual content parity and internal navigation without external services."""
from pathlib import Path
from zipfile import ZipFile
import json
import re
import sys
import unicodedata
from lxml import etree
from pypdf import PdfReader
from manual_meta import read_meta

ROOT = Path(__file__).resolve().parents[1]
MD = ROOT / 'docs/user-guide.md'
META = read_meta()
DOCX = ROOT / 'docs/manuals' / f'{META.filename}.docx'
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}


def norm(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', value))


def main():
    source = MD.read_text(encoding='utf-8')
    anchors = re.findall(r'<a id="([^"]+)"></a>', source)
    assert len(anchors) == len(set(anchors)), 'Duplicate source anchors'
    source_links = re.findall(r'\]\(([^)]+)\)', source)
    for target in source_links:
        if target.startswith('#'):
            assert target[1:] in anchors, target
        elif not target.startswith(('https://', 'http://')):
            assert (MD.parent / target.split('#')[0]).exists(), target
    with ZipFile(DOCX) as archive:
        document = etree.fromstring(archive.read('word/document.xml'))
        styles = etree.fromstring(archive.read('word/styles.xml'))
        texts = norm(''.join(document.xpath('//w:t/text()', namespaces=NS)))
        bookmarks = set(document.xpath('//w:bookmarkStart/@w:name', namespaces=NS))
        links = []
        for name in archive.namelist():
            if re.fullmatch(r'word/(document|footer\d+)\.xml', name):
                xml = etree.fromstring(archive.read(name))
                links.extend(xml.xpath('//w:hyperlink/@w:anchor', namespaces=NS))
        assert links and set(links) <= bookmarks, set(links) - bookmarks
        assert not styles.xpath('//w:pBdr', namespaces=NS), 'Unexpected decorative border'
        images = len(document.xpath('//*[local-name()="docPr"][@descr]'))
        source_images = len(re.findall(r'^!\[', source, re.M))
        assert images == source_images
    reader = PdfReader(DOCX.with_suffix('.pdf'))
    page_texts = []
    for index, page in enumerate(reader.pages):
        extracted = page.extract_text()
        # Word places the running header and footer before the body in the PDF
        # text stream. Remove them before joining paragraphs split by a page.
        if index > 0:
            extracted = extracted.split('\n', 2)[2]
        page_texts.append(extracted)
    pdf_text = norm(''.join(page_texts))
    missing, checked = [], 0
    for line in source.splitlines():
        line = line.strip()
        if not line or line.startswith(('<!--', '![', '<a ')):
            continue
        if line.startswith('|'):
            cells = [c.strip() for c in line.strip('|').split('|')]
            if all(re.fullmatch(r':?-+:?', c) for c in cells):
                continue
        else:
            if line.startswith('### '):
                line = re.sub(r'^### \d+\.\d+\s+', '', line)
            line = re.sub(r'^#{1,3} ', '', line)
            if line.startswith('- '):
                line = line[2:]
            cells = [line]
        for cell in cells:
            value = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', cell).replace('**', '').replace('`', '')
            checked += 1
            for format_name, body in [('DOCX', texts), ('PDF', pdf_text)]:
                if norm(value) not in body:
                    missing.append((format_name, cell))
    assert not missing, missing
    annotations = [a.get_object() for page in reader.pages for a in page.get('/Annots', [])]
    internal = []
    page_ids = {page.indirect_reference.idnum for page in reader.pages}
    for annotation in annotations:
        action = annotation.get('/A', {})
        if hasattr(action, 'get_object'):
            action = action.get_object()
        destination = annotation.get('/Dest')
        if destination is None and action.get('/S') == '/GoTo':
            destination = action.get('/D')
        if destination is None:
            continue
        internal.append(destination)
        if isinstance(destination, str):
            assert destination in reader.named_destinations, destination
            assert reader.get_destination_page_number(reader.named_destinations[destination]) is not None
        else:
            assert destination[0].idnum in page_ids, destination
    assert len(internal) >= len(links), (len(internal), len(links))
    report = {'pages': len(reader.pages), 'source_units_checked': checked, 'missing_content': missing,
              'images': images, 'markdown_internal_links': sum(t.startswith('#') for t in source_links),
              'docx_internal_links': len(links), 'pdf_internal_links': len(internal),
              'pdf_all_links': len(annotations), 'local_links': 'pass', 'bookmark_targets': 'pass'}
    output = ROOT / '.test-data/manual' / f'verification-v{META.version.replace(".", "")}.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    main()
