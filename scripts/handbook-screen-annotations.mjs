// Annotate actual UI elements. Captions and capture coordinates use one guide file.
export async function annotateScreenshot(page,guide){
 if(!guide?.purpose)throw new Error('Screenshot needs a purpose');
 if(guide.kind==='display'){
  if(!guide.explanation)throw new Error('Display screenshot needs an explanation');
  return {kind:'display',callouts:[]};
 }
 if(guide.kind!=='instruction'||!guide.callouts?.length)throw new Error('Instruction screenshot needs callouts');
 const targets=[];
 for(const item of guide.callouts){
  if(!item.text)throw new Error('Callout needs an explanation');
  const scope=item.scope?page.locator(item.scope):page;
  let target=item.button?scope.getByRole('button',{name:item.button,exact:true}):item.field?scope.getByLabel(item.field,{exact:true}):item.summary?scope.locator('summary').filter({hasText:new RegExp('^'+item.summary.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')}):scope.locator(item.selector);
  if(item.index!==undefined)target=target.nth(item.index);
  if(item.parent)target=target.locator('xpath=ancestor::'+item.parent+'[1]');
  if(await target.count()!==1)throw new Error('Callout must identify one element: '+JSON.stringify(item));
  await target.scrollIntoViewIfNeeded();
  targets.push({target,item});
 }
 const callouts=[];
 for(const {target,item} of targets){
  const box=await target.boundingBox(),size=page.viewportSize();
  if(!box||box.width<4||box.height<4||box.x<0||box.y<0||box.x+box.width>size.width+1||box.y+box.height>size.height+1)throw new Error('Callout outside screenshot: '+JSON.stringify({item,box}));
  callouts.push({number:callouts.length+1,text:item.text,box});
 }
 const positions=await page.evaluate(callouts=>{
  const rectangles=[];
  const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  while(walk.nextNode()){
   if(!walk.currentNode.textContent.trim()||walk.currentNode.parentElement.closest('script,style'))continue;
   const range=document.createRange();range.selectNodeContents(walk.currentNode);
   for(const rect of range.getClientRects())if(rect.width&&rect.height)rectangles.push(rect);
  }
  const badges=[];
  const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
  for(const item of callouts){
   const b=item.box,mark=document.createElement('div');
   mark.setAttribute('aria-hidden','true');mark.dataset.handbookCallout=String(item.number);
   Object.assign(mark.style,{position:'fixed',left:`${b.x-3}px`,top:`${b.y-3}px`,width:`${b.width+6}px`,height:`${b.height+6}px`,border:'2px solid #bd4b24',borderRadius:'6px',pointerEvents:'none',zIndex:'2147483646',boxSizing:'border-box'});
   const candidates=[[b.x-31,b.y-3],[b.x-3,b.y-31],[b.x+b.width+5,b.y-3],[b.x+b.width-25,b.y-31],[b.x-31,b.y+b.height-25],[b.x-3,b.y+b.height+5]].map(([x,y])=>({x,y,width:26,height:26}));
   for(const p of candidates)p.score=(p.x<2||p.y<2||p.x+26>innerWidth-2||p.y+26>innerHeight-2?1e8:0)+rectangles.reduce((sum,r)=>sum+overlap(p,r),0)+badges.reduce((sum,r)=>sum+100*overlap(p,r),0);
   candidates.sort((a,b)=>a.score-b.score);const pos=candidates[0];badges.push(pos);
   const badge=document.createElement('span');badge.textContent=String(item.number);
   Object.assign(badge.style,{position:'fixed',left:`${pos.x}px`,top:`${pos.y}px`,width:'26px',height:'26px',display:'grid',placeItems:'center',background:'#bd4b24',color:'#fff',border:'2px solid #fff',borderRadius:'50%',font:'bold 16px Arial',boxSizing:'border-box',zIndex:'2147483647'});
   document.body.append(mark,badge);
  }
  return badges.map(({x,y,width,height})=>({x,y,width,height}));
 },callouts);
 return {kind:'instruction',callouts:callouts.map((c,i)=>({...c,badge:positions[i]}))};
}
