"""Build an offline, self-contained task-oriented HTML manual from Markdown."""
from pathlib import Path
import re, json, html, base64
from urllib.parse import unquote
from manual_meta import RELATED, read_meta

ROOT=Path(__file__).resolve().parents[1]
DOCS=ROOT/'docs'
WEB=DOCS/'handbook'
STRUCTURE=json.loads((WEB/'structure.json').read_text(encoding='utf-8'))
DISPLAY_TITLES=STRUCTURE['titles']
DESTINATION_TITLES={}
RELATED_FRAGMENT_TARGETS={}
PAGE_ORDER=[page for group in STRUCTURE['groups'] for page in group['pages']]
if len(PAGE_ORDER)!=len(set(PAGE_ORDER)):
 raise ValueError('Duplicate page in handbook structure')
GROUPS={page:group['title'] for group in STRUCTURE['groups'] for page in group['pages']}
def plain(value):
 value=re.sub(r'!?\[([^\]]*)\]\([^)]+\)',r'\1',value)
 return re.sub(r'[*`#]','',value).strip()

def destination(target):
 filename,_,fragment=target.partition('#')
 if filename in RELATED:
  if fragment:
   key=(filename,unquote(fragment))
   if key not in RELATED_FRAGMENT_TARGETS: raise ValueError(f'Unknown reference heading: {target}')
   return '#'+RELATED_FRAGMENT_TARGETS[key]
  return '#'+RELATED[filename][0]
 if target.startswith(('#','http://','https://')): return target
 return read_meta().repository_url+'docs/'+target

def inline(text):
 result=[]
 for token in re.split(r'(\*\*.*?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))',text):
  m=re.fullmatch(r'\[([^\]]+)\]\(([^)]+)\)',token)
  if m:
   url=destination(m[2]); ext=' target="_blank" rel="noopener noreferrer"' if url.startswith('http') else ''
   label=DESTINATION_TITLES.get(url[1:],m[1]) if url.startswith('#') else m[1]
   result.append(f'<a href="{html.escape(url,quote=True)}"{ext}>{html.escape(label)}</a>')
  elif token.startswith('**'): result.append('<strong>'+html.escape(token[2:-2])+'</strong>')
  elif token.startswith('`'): result.append('<code>'+html.escape(token[1:-1])+'</code>')
  else: result.append(html.escape(token))
 return ''.join(result)

def list_item(raw):
 match=re.match(r'^(\s*)(\d+\.|[-*])\s+(.+)$',raw)
 if not match: return None
 marker=match[2]
 return {'indent':len(match[1].expandtabs(4)),'ordered':marker[0].isdigit(),
         'start':int(marker[:-1]) if marker[0].isdigit() else None,'text':match[3]}

def render_list_block(rows):
 def nested(position,indent):
  ordered=rows[position]['ordered'];tag='ol' if ordered else 'ul'
  start=f' start="{rows[position]["start"]}"' if ordered and rows[position]['start']!=1 else ''
  parts=[]
  while position<len(rows) and rows[position]['indent']==indent and rows[position]['ordered']==ordered:
   row=rows[position];position+=1;children=[]
   while position<len(rows) and rows[position]['indent']>indent:
    child,position=nested(position,rows[position]['indent']);children.append(child)
   parts.append('<li>'+inline(row['text'])+''.join(children)+'</li>')
  return f'<{tag}{start}>'+''.join(parts)+f'</{tag}>',position
 output=[];position=0
 while position<len(rows):
  part,position=nested(position,rows[position]['indent']);output.append(part)
 return ''.join(output)

def render(lines,prefix=''):
 output=[]; headings=[]; sections=[]; anchor=None; i=0; source=[]; section=None
 def flush_section():
  if section: sections.append({**section,'text':plain('\n'.join(source))})
 while i<len(lines):
  line=lines[i].strip(); i+=1
  if not line or line.startswith('<!--'): continue
  a=re.fullmatch(r'<a id="([^"]+)"></a>',line)
  if a: anchor=a[1]; continue
  if line.startswith('```'):
   code=[]
   while i<len(lines) and not lines[i].startswith('```'): code.append(lines[i]); i+=1
   i+=1; raw='\n'.join(code)
   output.append('<div class="code-block"><button type="button" class="copy-code">复制</button><pre><code>'+html.escape(raw)+'</code></pre></div>'); source.append(raw); continue
  heading=re.match(r'^(#{2,4}) (.+)$',line)
  if heading:
   flush_section(); source=[]
   title=re.sub(r'^\d+\.\d+\s+','',heading[2])
   identifier=anchor or prefix+'topic-'+str(len(headings)+1); anchor=None
   title=DISPLAY_TITLES.get(identifier,title)
   level='h3' if prefix and len(heading[1])>=3 else 'h2'
   headings.append({'id':identifier,'title':title,'level':level})
   output.append(f'<{level} id="{html.escape(identifier)}" tabindex="-1">{html.escape(title)}<a class="heading-link" href="#{html.escape(identifier)}" aria-label="定位到{html.escape(title)}">#</a></{level}>')
   section={'id':identifier,'title':title}; continue
  img=re.fullmatch(r'!\[([^\]]*)\]\(([^)]+)\)',line)
  if img:
   path=DOCS/img[2]; data=base64.b64encode(path.read_bytes()).decode('ascii')
   output.append(f'<figure><button class="zoom-image" type="button" aria-label="放大查看{html.escape(img[1])}"><img src="data:image/png;base64,{data}" alt="{html.escape(img[1])}" loading="lazy"><span>点击放大</span></button></figure>'); continue
  if line.startswith('|'):
   rows=[]
   while True:
    cells=[c.strip() for c in line.strip('|').split('|')]
    if not all(re.fullmatch(r':?-+:?',c) for c in cells): rows.append(cells); source.extend(cells)
    if i>=len(lines) or not lines[i].strip().startswith('|'): break
    line=lines[i].strip(); i+=1
   output.append('<div class="table-scroll cols-'+str(len(rows[0]))+'" tabindex="0"><span class="table-hint">左右滑动查看完整表格 →</span><table><thead><tr>'+''.join('<th scope="col">'+inline(c)+'</th>' for c in rows[0])+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+inline(c)+'</td>' for c in row)+'</tr>' for row in rows[1:])+'</tbody></table></div>'); continue
  first_item=list_item(lines[i-1])
  if first_item:
   rows=[first_item]
   while i<len(lines):
    next_item=list_item(lines[i])
    if not next_item: break
    rows.append(next_item);i+=1
   source.extend(row['text'] for row in rows)
   output.append(render_list_block(rows));continue
  if line.startswith('# '): continue
  source.append(line)
  cls=' class="figure-caption"' if re.match(r'^图 \d+ ',line) else ' class="next-actions"' if line.startswith('**接下来可以做') else ''
  output.append(f'<p{cls}>'+inline(line)+'</p>')
 flush_section()
 return ''.join(output),headings,sections

def internal_link(target):
 if target not in DESTINATION_TITLES: raise ValueError(f'Unknown handbook target: {target}')
 return f'<a href="#{html.escape(target,quote=True)}">{html.escape(DESTINATION_TITLES[target])}</a>'

def heading(identifier,title,level='h2'):
 return f'<{level} id="{html.escape(identifier,quote=True)}" tabindex="-1">{html.escape(title)}<a class="heading-link" href="#{html.escape(identifier,quote=True)}" aria-label="定位到{html.escape(title,quote=True)}">#</a></{level}>'

def quickstart_page(spec):
 steps=[]
 for step in spec['steps']:
  badge='<em class="optional-step">可选</em>' if step.get('optional') else ''
  steps.append(f'<li><div>{badge}{internal_link(step["target"])}<span>{html.escape(step["note"])}</span></div></li>')
 body=(f'<p class="home-intro">{html.escape(spec["intro"])}</p>'
       +'<ol class="path-list">'+''.join(steps)+'</ol>'
       +f'<p class="next-actions">{internal_link("start")} · {internal_link("help")}</p>')
 return {'id':spec['id'],'title':spec['title'],'group':GROUPS[spec['id']],
         'html':body,'headings':[],'sections':[],
         'text':spec['intro']+' '+' '.join(DESTINATION_TITLES[s['target']]+' '+s['note'] for s in spec['steps'])}

def enrich_home(article):
 config=STRUCTURE['home']
 cards=[]
 for index,card in enumerate(config['cards'],1):
  target=card['target']
  if target not in DESTINATION_TITLES: raise ValueError(f'Unknown home card target: {target}')
  cards.append(f'<a class="role-card" href="#{html.escape(target,quote=True)}"><span class="role-icon">{index:02d}</span><b>{html.escape(DESTINATION_TITLES[target])}</b><p>{html.escape(card["description"])}</p><span class="go">{html.escape(card["action"])}</span></a>')
 actions=''.join(f'<a class="quick-link" href="#{html.escape(target,quote=True)}">{html.escape(DESTINATION_TITLES[target])}<span aria-hidden="true">→</span></a>' for target in config['common_actions'])
 intro=(f'<p class="home-intro">{html.escape(config["intro"])}</p><div class="role-grid">'
        +''.join(cards)+'</div>'+heading('common-actions','常用操作')
        +f'<div class="quick-grid">{actions}</div>'
        +f'<p class="read-first">软件安装、服务器准备与升级请进入{internal_link(config["deployment_target"])}。模型服务无法直连时，可从{internal_link("section-14-2")}开始。</p>'
        +heading('complete-task-index','按任务查找'))
 article['html']=intro+article['html']
 article['headings']=[{'id':'common-actions','title':'常用操作','level':'h2'},
                      {'id':'complete-task-index','title':'按任务查找','level':'h2'}]
 article['sections']=[{'id':'common-actions','title':'常用操作','text':' '.join(DESTINATION_TITLES[target] for target in config['common_actions'])},
                      {'id':'complete-task-index','title':'按任务查找','text':article['text']}]

def enrich_gateway(article):
 path_id='egress-path'; cases_id='egress-scenarios'
 path_title='模型请求通过管理端的完整路径'; cases_title='查看完整使用场景'
 route=[('成员本机','用户版启动 Codex / Cursor CLI'),('本机代理','仅该 CLI 连接 127.0.0.1'),
        ('管理员电脑','TLS 出口与接入码校验，默认端口 18443'),('管理员上游','直连 / HTTP CONNECT / SOCKS5'),
        ('模型服务','Codex 或 Cursor 官方服务')]
 flow='<figure class="network-route" aria-label="成员通过管理端访问 Codex 和 Cursor 的模型请求路径"><figcaption>模型请求路径</figcaption><ol>'+''.join(f'<li><b>{html.escape(name)}</b><span>{html.escape(detail)}</span></li>' for name,detail in route)+'</ol><p><strong>团队资料路径：</strong>成员用户版 → SSH/SFTP → Linux 团队服务器。它不经过管理端模型出口。</p></figure>'
 case_links='<ul>'+''.join(f'<li>{internal_link(case_id)}</li>' for case_id in STRUCTURE['egress_case_ids'])+'</ul>'
 supplement=(heading(path_id,path_title)
             +'<p>总管理员负责开启并保持管理端出口运行；需要转发的成员在用户版填入接入码。只有工作台启动的模型 CLI 使用这条路径，浏览器和系统代理不变。</p>'
             +flow
             +'<p>成员继续使用自己的 Codex 或 Cursor 账号和额度。管理端只转发模型连接，不共享模型账号；项目、任务和文件仍按成员自己的 SSH 身份访问团队服务器。</p>'
             +f'<p class="route-role">操作入口：总管理员看{internal_link("section-14-1")}；成员看{internal_link("section-14-2")}；部署细节看{internal_link("egress-reference")}。</p>'
             +heading(cases_id,cases_title)
             +'<p>本机能直连模型时保持出口关闭；不能直连而能访问管理员电脑时，按下面的 A/B 场景核对两条网络路径和角色操作。上游代理配置与连接故障排查见本页后续小节。</p>'
             +case_links)
 marker='<h2 id="section-14-1"'
 if marker not in article['html']: raise ValueError('Gateway insertion point changed')
 article['html']=article['html'].replace(marker,supplement+marker,1)
 article['headings']=[{'id':path_id,'title':path_title,'level':'h2'},
                      {'id':cases_id,'title':cases_title,'level':'h2'},*article['headings']]
 article['sections']=[{'id':path_id,'title':path_title,'text':' '.join(name+' '+detail for name,detail in route)+' 团队 SSH/SFTP 通路独立 个人模型账号'},
                      {'id':cases_id,'title':cases_title,'text':' '.join(DESTINATION_TITLES[case_id] for case_id in STRUCTURE['egress_case_ids'])},*article['sections']]
 article['text']+=' '+path_title+' '+cases_title

def case_diagram(spec):
 lanes=[]
 for lane in spec['lanes']:
  nodes=''.join(f'<li>{html.escape(node)}</li>' for node in lane['nodes'])
  lanes.append(f'<div class="case-diagram-lane"><strong>{html.escape(lane["label"])}</strong><ol>{nodes}</ol></div>')
 return f'<figure class="case-diagram"><figcaption>{html.escape(spec["caption"])}</figcaption>'+''.join(lanes)+'</figure>'

def actor_table(actors):
 rows=''.join(f'<tr><td>{html.escape(actor["name"])}</td><td>{html.escape(actor["role"])}</td></tr>' for actor in actors)
 return '<div class="table-scroll cols-2" tabindex="0"><table><thead><tr><th scope="col">参与者</th><th scope="col">在此场景中的职责</th></tr></thead><tbody>'+rows+'</tbody></table></div>'

def bullet_list(items):
 return '<ul>'+''.join(f'<li>{html.escape(item)}</li>' for item in items)+'</ul>'

def use_case_page(case):
 steps=''.join(f'<li><strong>{html.escape(step["label"])}</strong><p>{html.escape(step["detail"])}</p></li>' for step in case['steps'])
 sections=[('roles','参与者与前提'),('steps','操作路径'),('done','完成标志'),('boundaries','关键边界'),('links','对应说明')]
 body=(f'<p class="home-intro">{html.escape(case["situation"])}</p>'
       +case_diagram(case['diagram'])
       +heading(case['id']+'-roles','参与者与前提')+actor_table(case['actors'])+bullet_list(case['prerequisites'])
       +heading(case['id']+'-steps','操作路径')+f'<ol class="case-steps">{steps}</ol>'
       +heading(case['id']+'-done','完成标志')+bullet_list(case['done'])
       +heading(case['id']+'-boundaries','关键边界')+bullet_list(case['boundaries'])
       +heading(case['id']+'-links','对应说明')
       +'<p class="next-actions">'+' · '.join(internal_link(target) for target in case['targets'])+'</p>')
 diagram_text=' '.join([case['diagram']['caption'],*(lane['label']+' '+' '.join(lane['nodes']) for lane in case['diagram']['lanes'])])
 sections_text=[('roles',' '.join(actor['name']+' '+actor['role'] for actor in case['actors'])+' '+' '.join(case['prerequisites'])),
                ('steps',' '.join(step['label']+' '+step['detail'] for step in case['steps'])),
                ('done',' '.join(case['done'])),('boundaries',' '.join(case['boundaries'])),
                ('links',' '.join(DESTINATION_TITLES[target] for target in case['targets']))]
 return {'id':case['id'],'title':case['title'],'group':GROUPS[case['id']],
         'html':body,
         'headings':[{'id':case['id']+'-'+suffix,'title':title,'level':'h2'} for suffix,title in sections],
         'sections':[{'id':case['id']+'-'+suffix,'title':dict(sections)[suffix],'text':content} for suffix,content in sections_text],
         'text':' '.join([case['situation'],diagram_text,*(content for _,content in sections_text)])}

def enrich_algorithm_example(article):
 spec=STRUCTURE['example_details']
 roles_id='example-roles';walk_id='example-walkthrough';checks_id='example-checks'
 original=article['html'];marker='<p class="next-actions"';at=original.rfind(marker)
 if at<0: raise ValueError('Example closing links changed')
 main,tail=original[:at],original[at:]
 article['html']=(f'<p class="home-intro">{html.escape(spec["summary"])}</p>'
                  +case_diagram(spec['diagram'])
                  +heading(roles_id,'参与者与共同目标')+actor_table(spec['actors'])
                  +heading(walk_id,'逐轮协作过程')+main
                  +heading(checks_id,'完成时核对')+bullet_list(spec['checks'])
                  +'<p class="related-note">对应操作：'+' · '.join(internal_link(target) for target in spec['targets'])+'</p>'
                  +tail)
 article['headings']=[{'id':identifier,'title':title,'level':'h2'} for identifier,title in
                      [(roles_id,'参与者与共同目标'),(walk_id,'逐轮协作过程'),(checks_id,'完成时核对')]]
 article['sections']=[{'id':roles_id,'title':'参与者与共同目标','text':spec['summary']+' '+' '.join(actor['name']+' '+actor['role'] for actor in spec['actors'])},
                      {'id':walk_id,'title':'逐轮协作过程','text':article['text']},
                      {'id':checks_id,'title':'完成时核对','text':' '.join(spec['checks'])}]
 article['text']+=' '+spec['summary']+' '+' '.join(spec['checks'])

def add_related(article,lead,targets):
 note=f'<p class="related-note">{html.escape(lead)}'+ ' · '.join(internal_link(target) for target in targets)+'</p>'
 marker='<p class="next-actions"'
 position=article['html'].rfind(marker)
 if position>=0: article['html']=article['html'][:position]+note+article['html'][position:]
 else: article['html']+=note
 article['text']+=' '+lead+' '+' '.join(DESTINATION_TITLES[target] for target in targets)

def main():
 DESTINATION_TITLES.clear();RELATED_FRAGMENT_TARGETS.clear()
 source=(DOCS/'user-guide.md').read_text(encoding='utf-8')
 # Keep link sentences readable after the HTML view displays destination titles.
 html_only_edits={
  '可按[管理端网络出口](#gateway)的步骤接入管理员提供的转发通路':'接入管理员转发通路的做法见[管理端网络出口](#gateway)',
  '确需借用管理端出口时，按[用户端接入步骤](#section-14-2)填写接入码。':'确需借用管理端出口时，填写接入码的方法见[用户端接入](#section-14-2)。',
  '普通文件和轨迹可[单独上传](#files)':'普通文件和轨迹的操作见[单独上传](#files)',
  '服务器环境待完善时按[管理问题处理](#section-16-3)操作，详细准备步骤见独立部署指导':'服务器环境待完善时，排查入口见[管理问题处理](#section-16-3)；详细准备步骤见独立部署指导'
 }
 for old,new in html_only_edits.items(): source=source.replace(old,new)
 for identifier,_,title in re.findall(r'<a id="([^"]+)"></a>\s*\n(#{2,3})\s+([^\n]+)',source):
  title=re.sub(r'^\d+(?:\.\d+)?\s+','',title).strip()
  DESTINATION_TITLES[identifier]=DISPLAY_TITLES.get(identifier,title)
 for _,(identifier,title) in RELATED.items(): DESTINATION_TITLES[identifier]=DISPLAY_TITLES.get(identifier,title)
 for spec in STRUCTURE['quickstarts']: DESTINATION_TITLES[spec['id']]=spec['title']
 for case in STRUCTURE['use_cases']: DESTINATION_TITLES[case['id']]=case['title']
 DESTINATION_TITLES.update({'common-actions':'常用操作','complete-task-index':'按任务查找',
                            'egress-path':'模型请求通过管理端的完整路径',
                            'egress-scenarios':'查看完整使用场景'})
 for filename,(identifier,_) in RELATED.items():
  raw=(DOCS/filename).read_text(encoding='utf-8'); pending=None; number=0
  for line in raw.splitlines():
   anchor=re.fullmatch(r'<a id="([^"]+)"></a>',line.strip())
   if anchor: pending=anchor[1]; continue
   heading=re.match(r'^(#{2,4}) (.+)$',line.strip())
   if not heading: continue
   number+=1; title=re.sub(r'^\d+\.\d+\s+','',heading[2]).strip()
   target_id=pending or identifier+'-topic-'+str(number); pending=None
   slug=re.sub(r'\s+','-',re.sub(r'[^\w\s-]','',heading[2].lower())).strip('-')
   RELATED_FRAGMENT_TARGETS[(filename,slug)]=target_id
   DESTINATION_TITLES[target_id]=title
 pattern=r'<a id="([^"]+)"></a>\s*\n## ([^\n]+)'
 matches=list(re.finditer(pattern,source)); articles=[]
 for i,m in enumerate(matches):
  identifier=m[1]; title=DISPLAY_TITLES.get(identifier,re.sub(r'^\d+ ','',m[2])); end=matches[i+1].start() if i+1<len(matches) else len(source)
  body,headings,sections=render(source[m.end():end].splitlines())
  articles.append({'id':identifier,'title':title,'group':GROUPS[identifier],'html':body,'headings':headings,'sections':sections,'text':plain(source[m.end():end])})
 for filename,(identifier,title) in RELATED.items():
  raw=(DOCS/filename).read_text(encoding='utf-8'); body,headings,sections=render(raw.splitlines(),identifier+'-')
  articles.append({'id':identifier,'title':DESTINATION_TITLES[identifier],'group':GROUPS[identifier],'html':body,'headings':headings,'sections':sections,'text':plain(raw)})
 articles.extend(quickstart_page(spec) for spec in STRUCTURE['quickstarts'])
 articles.extend(use_case_page(spec) for spec in STRUCTURE['use_cases'])
 article_by_id={article['id']:article for article in articles}
 if len(article_by_id)!=len(articles): raise ValueError('Duplicate handbook page ID')
 if set(article_by_id)!=set(PAGE_ORDER):
  raise ValueError(f'Handbook structure mismatch: missing={set(article_by_id)-set(PAGE_ORDER)}, extra={set(PAGE_ORDER)-set(article_by_id)}')
 enrich_home(article_by_id['start'])
 enrich_algorithm_example(article_by_id['example'])
 enrich_gateway(article_by_id['gateway'])
 article_by_id['deployment']['html']=(
  '<p class="read-first">部署时分开核对两条连接：团队项目和文件由成员用户版通过 SSH/SFTP 访问 Linux 服务器；模型请求由成员自己的 Codex 或 Cursor CLI 发出。成员不能直连模型时，按'
  +internal_link('egress-path')+'经管理员电脑转发，并用'+internal_link('case-egress-mixed')+'核对实际场景。</p>'
  +article_by_id['deployment']['html'])
 article_by_id['deployment']['text']+=' 团队 SSH/SFTP 通路与模型网络出口独立 管理端转发 Codex Cursor'
 add_related(article_by_id['conclusions'],'成果分类的设置与使用细节：',['classification-reference-topic-1'])
 add_related(article_by_id['tasks'],'任务入口及文件的详细边界：',['classification-reference-topic-5','classification-reference-topic-6'])
 add_related(article_by_id['egress-reference'],'按界面操作：',['section-14-1','section-14-2'])
 articles=[article_by_id[identifier] for identifier in PAGE_ORDER]
 all_targets=[identifier for article in articles for identifier in [article['id'],*(h['id'] for h in article['headings'])]]
 if len(all_targets)!=len(set(all_targets)): raise ValueError('Duplicate handbook page or heading ID')
 stale_titles=set(DISPLAY_TITLES)-set(all_targets)
 if stale_titles: raise ValueError(f'Title overrides without destinations: {stale_titles}')
 actual_titles={article['id']:article['title'] for article in articles}
 actual_titles.update({heading['id']:heading['title'] for article in articles for heading in article['headings']})
 for target,title in DESTINATION_TITLES.items():
  if target not in actual_titles: raise ValueError(f'Title target not rendered: {target}')
  if actual_titles[target]!=title: raise ValueError(f'Title drift at {target}: {title} != {actual_titles[target]}')
 data=json.dumps(articles,ensure_ascii=False).replace('</',r'<\/')
 navigation=json.dumps({'groups':STRUCTURE['groups'],
                        'search_defaults':STRUCTURE['home']['search_defaults']},ensure_ascii=False).replace('</',r'<\/')
 template=(WEB/'template.html').read_text(encoding='utf-8')
 meta=read_meta()
 template=(template.replace('/*__VERSION__*/',meta.version)
           .replace('/*__SOFTWARE_VERSION__*/',meta.software_version)
           .replace('/*__COMMIT__*/',meta.commit)
           .replace('/*__DATE__*/',meta.date)
           .replace('/*__FILENAME__*/',meta.filename))
 script=(WEB/'handbook.js').read_text(encoding='utf-8').replace('/*__VERSION__*/',meta.version).replace('/*__SOFTWARE_VERSION__*/',meta.software_version)
 output=(template.replace('/*__STYLE__*/',(WEB/'handbook.css').read_text(encoding='utf-8'))
         .replace('/*__SCRIPT__*/',script).replace('/*__ARTICLES__*/',data)
         .replace('/*__STRUCTURE__*/',navigation))
 (WEB/'index.html').write_text(output,encoding='utf-8')
 # Preserve the interface walkthroughs whenever the handbook is rebuilt.
 from handbook_ui_scenarios import enhance_html
 enhance_html(WEB/'index.html')
 print(f'Built {len(articles)} topics, {sum(len(a["sections"]) for a in articles)} sections; {len(output.encode())} bytes. No external runtime dependencies.')

if __name__=='__main__': main()
