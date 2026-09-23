"""Build the distributable DOCX from docs/user-guide.md (requires python-docx).

The Markdown is the source of truth. PDF export is a separate layout verification
step; see docs/manual-maintenance.md. No model or server connection is used.
"""
from __future__ import annotations
import argparse
import re
from pathlib import Path
from docx import Document
from docx.shared import Cm, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from manual_meta import read_meta

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'docs/user-guide.md'
META = read_meta()
OUTPUT = ROOT / 'docs/manuals' / f'{META.filename}.docx'
REFERENCE_ROOT = META.repository_url + 'docs/'

def font(run, size=None, bold=None, color='203344'):
    run.font.name = 'Microsoft YaHei'
    run._element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')
    if size: run.font.size = Pt(size)
    if bold is not None: run.bold = bold
    run.font.color.rgb = RGBColor.from_string(color)

def inline(p, text, size=None):
    # The manual intentionally uses a small, deterministic Markdown subset.
    for token in re.split(r'(\*\*.*?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))', text):
        if not token: continue
        link = re.fullmatch(r'\[([^\]]+)\]\(([^)]+)\)', token)
        if link:
            label, target = link.groups()
            node = OxmlElement('w:hyperlink')
            if target.startswith('#'):
                node.set(qn('w:anchor'),'m_'+target[1:].replace('-','_'))
            else:
                if not target.startswith(('http:', 'https:')): target = REFERENCE_ROOT + target
                rel = p.part.relate_to(target, RT.HYPERLINK, is_external=True)
                node.set(qn('r:id'), rel)
            run = p.add_run(label); font(run, size, color='087F79')
            run.underline=True
            node.append(run._r); p._p.append(node)
        elif token.startswith('**'):
            font(p.add_run(token[2:-2]), size, True)
        elif token.startswith('`'):
            font(p.add_run(token[1:-1]), size)
        else:
            font(p.add_run(token), size)

def bookmark(p, name, number):
    start=OxmlElement('w:bookmarkStart'); start.set(qn('w:id'),str(number)); start.set(qn('w:name'),name)
    end=OxmlElement('w:bookmarkEnd'); end.set(qn('w:id'),str(number))
    p._p.insert(0,start); p._p.append(end)

def table(doc, rows):
    columns = len(rows[0]); t=doc.add_table(rows=1, cols=columns)
    t.alignment=WD_TABLE_ALIGNMENT.CENTER; t.autofit=False
    if columns==2: widths=[5.0,12.0]
    elif columns==3: widths=[3.0,5.6,8.4]
    else: widths=[2.0,5.5,5.5,4.0]
    if rows[0][0]=='身份': widths=[3.2,2.4,11.4]
    elif rows[0][0]=='信息': widths=[4.6,4.0,8.4]
    elif rows[0][0]=='提供方': widths=[2.1,5.8,9.1]
    for col,w in zip(t.columns,widths): col.width=Cm(w)
    pr=t._tbl.tblPr
    borders=OxmlElement('w:tblBorders')
    for edge in ['top','left','bottom','right','insideH','insideV']:
        b=OxmlElement('w:'+edge)
        b.set(qn('w:val'),'single')
        b.set(qn('w:sz'),'4')
        b.set(qn('w:color'),'D9E2E6')
        borders.append(b)
    pr.append(borders)
    for index,values in enumerate(rows):
        row=t.rows[0] if index==0 else t.add_row()
        rowpr=row._tr.get_or_add_trPr(); rowpr.append(OxmlElement('w:cantSplit'))
        if index==0: rowpr.append(OxmlElement('w:tblHeader'))
        for cell,value,width in zip(row.cells,values,widths):
            cell.width=Cm(width); cell.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER
            cp=cell._tc.get_or_add_tcPr(); margins=OxmlElement('w:tcMar')
            for side,amount in [('top','105'),('bottom','105'),('left','135'),('right','135')]:
                n=OxmlElement('w:'+side); n.set(qn('w:w'),amount); n.set(qn('w:type'),'dxa'); margins.append(n)
            cp.append(margins)
            if index==0 or index%2==0:
                shade=OxmlElement('w:shd'); shade.set(qn('w:fill'),'E9F1F4' if index==0 else 'FAFCFD'); cp.append(shade)
            p=cell.paragraphs[0]; p.paragraph_format.space_after=Pt(0); p.paragraph_format.line_spacing=Pt(14.4)
            p.paragraph_format.keep_with_next=index==0
            inline(p,value,9.5)
            if rows[0][0]=='您要完成的工作' and value.startswith('第 '):
                first=re.search(r'第 (\d+)',value)
                if first:
                    link=OxmlElement('w:hyperlink'); link.set(qn('w:anchor'),'chapter_'+str(int(first[1])+1))
                    for r in list(p._p.findall(qn('w:r'))): link.append(r)
                    p._p.append(link)
            if index==0:
                for r in p.runs: font(r,9.5,True,color='17324D')
    after=doc.add_paragraph(); after.paragraph_format.space_after=Pt(0); after.paragraph_format.space_before=Pt(0)
    after.paragraph_format.line_spacing=Pt(5); font(after.add_run(''),4)

def build(output):
    doc=Document(); sec=doc.sections[0]
    # Clear decorative defaults from the installed python-docx template.
    for style in doc.styles:
        for border in list(style.element.iter(qn('w:pBdr'))): border.getparent().remove(border)
    sec.page_width=Cm(21); sec.page_height=Cm(29.7)
    sec.top_margin=Cm(1.8); sec.bottom_margin=Cm(1.8); sec.left_margin=Cm(2); sec.right_margin=Cm(2)
    sec.header_distance=Cm(.8); sec.footer_distance=Cm(.85); sec.different_first_page_header_footer=True
    normal=doc.styles['Normal']; normal.font.name='Microsoft YaHei'; normal.font.size=Pt(10.5)
    normal._element.rPr.rFonts.set(qn('w:eastAsia'),'Microsoft YaHei')
    normal.paragraph_format.line_spacing=Pt(16.5); normal.paragraph_format.space_after=Pt(8)
    snap=OxmlElement('w:snapToGrid'); snap.set(qn('w:val'),'0'); normal._element.get_or_add_pPr().append(snap)
    normal.paragraph_format.widow_control=True
    for name,size in [('Title',30),('Subtitle',16),('Heading 1',19),('Heading 2',12.5)]:
        st=doc.styles[name]; st.font.name='Microsoft YaHei'; st.font.size=Pt(size); st.font.color.rgb=RGBColor.from_string('20252A')
        st.font.italic=False; st.font.underline=False
        st._element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'),'Microsoft YaHei')
        st.paragraph_format.space_before=Pt(11 if name=='Heading 2' else 0)
        st.paragraph_format.space_after=Pt(8 if name=='Heading 2' else 9); st.paragraph_format.keep_with_next=True
        st.paragraph_format.line_spacing=1.1
    header=sec.header.paragraphs[0]; font(header.add_run('团队工作台  /  使用手册'),8,color='607383')
    footer=sec.footer.paragraphs[0]; footer.alignment=WD_ALIGN_PARAGRAPH.RIGHT
    inline(footer,'[返回任务导航](#start)',8)
    font(footer.add_run(f'   |   v{META.version}   |   '),8,color='607383')
    field=OxmlElement('w:fldSimple'); field.set(qn('w:instr'),'PAGE'); footer._p.append(field)
    doc.core_properties.title='团队工作台使用手册'; doc.core_properties.subject='用户版与管理员版操作说明'
    doc.core_properties.author='Team Agent Workbench'; doc.core_properties.keywords=f'使用手册,用户版,管理员版,{META.software_version}'
    doc.core_properties.comments=''; doc.core_properties.last_modified_by='Team Agent Workbench'
    lines=SOURCE.read_text(encoding='utf-8').splitlines(); index=0; cover=True; heading_id=0; new_page=False; pending_anchor=None
    while index<len(lines):
        line=lines[index].strip(); index+=1
        if not line: continue
        anchor=re.fullmatch(r'<a id="([^"]+)"></a>',line)
        if anchor:
            pending_anchor='m_'+anchor[1].replace('-','_')
            continue
        if line=='<!-- pagebreak -->': new_page=True; cover=False; continue
        if line.startswith('# '):
            p=doc.add_paragraph(line[2:],style='Title'); p.paragraph_format.space_before=Cm(3.8)
            p.paragraph_format.space_after=Pt(22)
            continue
        if cover and line=='用户版与管理员版':
            p=doc.add_paragraph(line,style='Subtitle'); p.paragraph_format.space_after=Cm(1.6); continue
        if line.startswith('## '):
            p=doc.add_paragraph(line[3:],style='Heading 1'); heading_id+=1
            p.paragraph_format.page_break_before=new_page; new_page=False
            bookmark(p,pending_anchor or 'chapter_'+str(heading_id),heading_id); pending_anchor=None; continue
        if line.startswith('### '):
            # Chapter numbers remain on H1; subheadings use plain words.
            heading=re.sub(r'^\d+\.\d+\s+','',line[4:])
            p=doc.add_paragraph(heading,style='Heading 2'); p.paragraph_format.page_break_before=new_page; new_page=False
            heading_id+=1; bookmark(p,pending_anchor or 'topic_'+str(heading_id),heading_id); pending_anchor=None; continue
        img=re.fullmatch(r'!\[([^\]]*)\]\(([^)]+)\)',line)
        if img:
            p=doc.add_paragraph(); p.paragraph_format.keep_with_next=True
            p.paragraph_format.line_spacing=1.0
            pic=p.add_run().add_picture(str(SOURCE.parent/img[2]),width=Cm(17))
            pic._inline.docPr.set('descr',img[1]); continue
        if line.startswith('|'):
            rows=[]
            while True:
                cells=[c.strip() for c in line.strip('|').split('|')]
                if not all(re.fullmatch(r':?-+:?',c) for c in cells): rows.append(cells)
                if index>=len(lines) or not lines[index].strip().startswith('|'): break
                line=lines[index].strip(); index+=1
            table(doc,rows); continue
        p=doc.add_paragraph()
        if re.match(r'^图 \d+ ',line):
            p.alignment=WD_ALIGN_PARAGRAPH.CENTER; p.paragraph_format.space_after=Pt(10); inline(p,line,8)
        elif re.match(r'^\d+\. ',line):
            p.paragraph_format.left_indent=Cm(.55); p.paragraph_format.first_line_indent=Cm(-.55)
            p.paragraph_format.space_after=Pt(6); inline(p,line)
        elif line.startswith('- '):
            p.paragraph_format.left_indent=Cm(.55); p.paragraph_format.first_line_indent=Cm(-.55)
            p.paragraph_format.space_after=Pt(6); inline(p,'• '+line[2:])
        elif line.startswith('**接下来可以做：**'):
            p.paragraph_format.space_before=Pt(10); p.paragraph_format.space_after=Pt(8)
            inline(p,line,9)
        else: inline(p,line)
    output.parent.mkdir(parents=True,exist_ok=True); doc.save(output)
    print(f'DOCX: {output}')
    print(f'Source: {len(lines)} lines, {heading_id} chapter headings')

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--output',type=Path,default=OUTPUT)
    build(parser.parse_args().output)
