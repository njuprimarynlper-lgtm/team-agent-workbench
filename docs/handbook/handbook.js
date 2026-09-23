(() => {
  'use strict';
  const articles = JSON.parse(document.getElementById('manual-data').textContent);
  const structure = JSON.parse(document.getElementById('manual-structure').textContent);
  const $ = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const destinationTitle = new Map(articles.flatMap(a => [[a.id,a.title],...a.headings.map(h=>[h.id,h.title])]));
  const titleFor = id => { const title=destinationTitle.get(id); if(!title)throw new Error(`No manual heading for ${id}`); return title; };
  const byId = new Map(articles.map(a=>[a.id,a]));
  const owner = new Map();
  articles.forEach(a=>{owner.set(a.id,a);a.headings.forEach(h=>owner.set(h.id,a));});
  const groupPages=new Map(structure.groups.map(group=>[group.title,group.pages.filter(id=>id!=='start'&&!id.startsWith('quickstart-')).map(id=>byId.get(id))]));
  $('navigation').innerHTML=structure.groups.map(group=>{
    const links=group.pages.filter(id=>id!=='start').map(id=>byId.get(id)).map(article=>`<a class="nav-link" href="#${article.id}" data-page="${article.id}">${escape(article.title)}</a>`).join('');
    if(group.pages.includes('start'))return `<section class="nav-group nav-group-start"><h2><a class="nav-group-home" href="#start" data-page="start">${escape(titleFor('start'))}</a></h2>${links}</section>`;
    return group.collapsed?`<details class="nav-group"><summary>${escape(group.title)}</summary>${links}</details>`:`<section class="nav-group"><h2>${escape(group.title)}</h2>${links}</section>`;
  }).join('');
  let current, observer, toastTimer;
  function announce(text) { $('toast').textContent=text; $('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),2400); }
  function closeMenu(){ $('sidebar').classList.remove('open');$('menu-toggle').setAttribute('aria-expanded','false'); }
  function scrollSidebarCurrent(){
    if(window.innerWidth<=760)return;
    const selected=$('navigation').querySelector('[aria-current="page"]');
    if(!selected)return;
    const item=selected.getBoundingClientRect(), container=$('sidebar').getBoundingClientRect();
    if(item.top<container.top+18)$('sidebar').scrollTop+=item.top-container.top-18;
    else if(item.bottom>container.bottom-18)$('sidebar').scrollTop+=item.bottom-container.bottom+18;
  }
  function render() {
    let hash;try{hash=decodeURIComponent(location.hash.slice(1)||'start');}catch{hash='invalid-link';}
    if(hash==='article'){ $('article').focus();return; }
    const article=owner.get(hash);
    if(!article){
      current=undefined;observer?.disconnect();document.title='链接未找到 · 团队工作台使用手册';
      document.querySelectorAll('.nav-link,.nav-group-home').forEach(el=>el.removeAttribute('aria-current'));
      $('article').classList.remove('is-home');
      $('article').innerHTML=`<h1>没有找到这个位置</h1><p>链接可能已变更。可以返回<a href="#start">${escape(titleFor('start'))}</a>，或搜索需要的操作。</p><button type="button" id="missing-search">搜索手册</button>`;
      $('missing-search').onclick=openSearch; $('page-toc').replaceChildren();$('page-toc').parentElement.hidden=true;$('reading-layout').classList.add('no-toc');$('breadcrumb').textContent='链接未找到';$('previous-page').removeAttribute('href');$('next-page').removeAttribute('href');document.querySelector('.page-navigation').hidden=true;return;
    }
    if(current!==article.id){
      current=article.id;document.title=article.title+' · 团队工作台使用手册';
      $('article').classList.toggle('is-home',article.id==='start');
      $('article').innerHTML=`${article.id==='start'?'':`<div class="eyebrow">${escape(article.group)}</div>`}<h1>${escape(article.title)}</h1>${article.id==='start'?'':'<p class="article-meta">适用版本 /*__SOFTWARE_VERSION__*/ · 手册 v/*__VERSION__*/</p>'}${article.html}`;
      $('page-toc').parentElement.hidden=!article.headings.length;
      $('reading-layout').classList.toggle('no-toc',!article.headings.length);
      $('page-toc').innerHTML=article.headings.length?article.headings.map(h=>`<a class="${h.level==='h3'?'toc-sub':''}" href="#${h.id}">${escape(h.title)}</a>`).join('')+`<a href="#${article.id}">回到本篇开头 ↑</a>`:'';
      document.querySelectorAll('.nav-link,.nav-group-home').forEach(el=>{if(el.dataset.page===article.id){el.setAttribute('aria-current','page');const details=el.closest('details');if(details)details.open=true;}else el.removeAttribute('aria-current');});
      const siblings=groupPages.get(article.group)||[];
      const index=siblings.indexOf(article);
      const neighbors=article.id==='start'?[['previous-page',null,''],['next-page',null,'']]:article.id.startsWith('quickstart-')?[['previous-page',byId.get('start'),'返回开始使用'],['next-page',null,'']]:[['previous-page',siblings[index-1],'上一主题'],['next-page',siblings[index+1],'下一主题']];
      document.querySelector('.page-navigation').hidden=neighbors.every(([,next])=>!next);
      for(const [id,next,label] of neighbors){
        const el=$(id);el.innerHTML=next?`<small>${label}</small>${escape(next.title)} ${id==='next-page'?'→':''}`:'';
        if(next)el.setAttribute('href','#'+next.id);else el.removeAttribute('href');
      }
      observer?.disconnect();observer=new IntersectionObserver(entries=>{const visible=entries.filter(e=>e.isIntersecting);if(!visible.length)return;const id=visible[0].target.id;$('page-toc').querySelectorAll('a').forEach(a=>a.setAttribute('aria-current',a.hash==='#'+id?'true':'false'));},{rootMargin:'-100px 0px -60% 0px'});
      $('article').querySelectorAll('h2[id],h3[id]').forEach(el=>observer.observe(el));
      requestAnimationFrame(scrollSidebarCurrent);
    }
    const deepTitle=hash!==article.id?destinationTitle.get(hash):null;
    if(article.id==='start')$('breadcrumb').innerHTML=deepTitle?`<a href="#start">${escape(article.title)}</a><span>/</span>${escape(deepTitle)}`:escape(article.title);
    else $('breadcrumb').innerHTML=`<a href="#start">${escape(titleFor('start'))}</a><span>/</span>${article.group===byId.get('start').group?'':escape(article.group)+'<span>/</span>'}${deepTitle?`<a href="#${article.id}">${escape(article.title)}</a><span>/</span>${escape(deepTitle)}`:escape(article.title)}`;
    closeMenu();
    requestAnimationFrame(()=>{const target=hash!==article.id?$(hash):null;if(target){target.scrollIntoView({block:'start'});target.focus({preventScroll:true});}else{window.scrollTo(0,0);$('article').focus({preventScroll:true});}});
  }
  window.addEventListener('hashchange',render);
  document.addEventListener('click',event=>{
    const a=event.target.closest('a[href^="#"]');
    if(a&&a.hash===location.hash){event.preventDefault();render();}
    if(a&&$('search-dialog').open)$('search-dialog').close();
    const zoom=event.target.closest('.zoom-image');if(zoom){const img=zoom.querySelector('img');$('large-image').src=img.src;$('large-image').alt=img.alt;$('image-caption').textContent=img.alt;$('image-dialog').showModal();}
    const close=event.target.closest('[data-close]');if(close)$(close.dataset.close).close();
    const copy=event.target.closest('.copy-code');if(copy)copyText(copy.parentElement.querySelector('code').textContent,'代码已复制');
  });
  $('menu-toggle').onclick=()=>{const open=$('sidebar').classList.toggle('open');$('menu-toggle').setAttribute('aria-expanded',String(open));};
  $('print-page').onclick=()=>window.print();
  async function copyText(text,message){
    try{if(navigator.clipboard){await navigator.clipboard.writeText(text);announce(message);return;}}catch{}
    $('copy-value').value=text;$('copy-dialog').showModal();$('copy-value').focus();$('copy-value').select();
  }
  $('copy-link').onclick=()=>copyText(location.href.split('#')[0]+(location.hash||'#start'),'当前链接已复制');
  const index=articles.flatMap(a=>[{id:a.id,title:a.title,group:a.group,parent:'',text:a.text},...a.sections.map(s=>({...s,group:a.group,parent:a.title}))]);
  const aliases={'登陆':'登录','加人':'添加 成员 创建 账号','加组':'添加 成员 工作组','发给同事':'上传 成果','共享结论':'团队成果 本地成果','额度':'额度 模型 账号','沙盒':'权限 批准','打不开':'失败 登录 连接','插件':'插件 Skill MCP','轨迹':'轨迹 对话 历史','子管理员':'组管理员','同步':'动态 更新 参考','密码':'账号 登录 密码','退出':'关闭 会话'};
  const normalize=text=>text.normalize('NFKC').toLowerCase().replace(/登陆/g,'登录');
  const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter('zh-CN',{granularity:'word'}):null;
  function tokens(query){
    const found=new Set([query]);
    if(segmenter){for(const part of segmenter.segment(query))if(part.isWordLike&&part.segment.length>1)found.add(part.segment);}
    else{query.split(/\s+/).filter(Boolean).forEach(p=>found.add(p));}
    for(const [key,value] of Object.entries(aliases))if(query.includes(key))value.toLowerCase().split(' ').forEach(v=>found.add(v));
    return [...found].filter(t=>!['怎么','如何','什么','我的','可以','需要','一个','不了'].includes(t));
  }
  function excerpt(text,terms){
    const cleaned=text.replace(/<[^>]*>|<!--.*?-->/g,'').replace(/\s+/g,' ');const normalized=normalize(cleaned);
    let at=terms.map(t=>normalized.indexOf(t)).filter(v=>v>=0).sort((a,b)=>a-b)[0]||0;
    const part=cleaned.slice(Math.max(0,at-25),Math.max(0,at-25)+140);
    return (at>25?'…':'')+escape(part)+'…';
  }
  function search(){
    const q=normalize($('search-input').value.trim());
    if(!q){$('search-status').textContent='常用操作';$('search-results').innerHTML=structure.search_defaults.map(id=>`<a class="search-result" href="#${id}"><strong>${escape(titleFor(id))}</strong></a>`).join('');return;}
    const terms=tokens(q);const scored=index.map(item=>{const title=normalize(item.title),text=normalize(item.text);let score=title.includes(q)?130:0;if(text.includes(q))score+=25;for(const term of terms){if(title.includes(term))score+=30;if(text.includes(term))score+=4;}if(item.parent)score+=score>0?2:0;return {item,score};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
    const found=[...new Map(scored.map(x=>[x.item.id,x])).values()].slice(0,16);
    $('search-status').textContent=found.length?`找到 ${scored.length} 项，显示最相关的 ${found.length} 项`:'没有匹配的内容';
    $('search-results').innerHTML=found.length?found.map(({item})=>`<a class="search-result" href="#${item.id}"><small>${escape(item.group)}${item.parent?' / '+escape(item.parent):''}</small><strong>${escape(item.title)}</strong><p>${excerpt(item.text,terms)}</p></a>`).join(''):`<div class="no-results">试试更短的词，例如“权限”“上传”或“成员”。也可打开<a href="#start">${escape(titleFor('start'))}</a>。</div>`;
  }
  function openSearch(){if(!$('search-dialog').open)$('search-dialog').showModal();search();$('search-input').focus();$('search-input').select();}
  $('search-open').onclick=openSearch;$('search-input').oninput=search;
  $('search-input').addEventListener('keydown',event=>{if(event.key==='Enter'){const first=$('search-results').querySelector('a');if(first){event.preventDefault();first.click();}}if(event.key==='ArrowDown'){event.preventDefault();$('search-results').querySelector('a')?.focus();}});
  document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openSearch();}if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){event.preventDefault();openSearch();}});
  for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
  render();
})();
