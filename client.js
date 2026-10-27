window.__ModuleLoader__.load({id:'dsh-codex-memory',factory:require=>{
 const react=require('react'),h=react.createElement,NS='dsh-codex-memory.settings',BASE='/dsh-codex-memory'
 const zh={nav:'记忆',title:'Codex V2 记忆',save:'保存设置',refresh:'刷新状态',loading:'加载中…',saved:'已保存；新作业使用新配置。',inherit:'继承触发会话',runtime:'运行时解析',unsupported:'当前模型不支持',legacy:'旧配置原值',default:'默认值',explicit:'已保存值',stage1:'抽取阶段',stage2:'整合阶段',provider:'Provider',model:'模型',effort:'思考强度',codex:'Codex 默认',parent:'继承父会话强度',providerDefault:'Provider 默认',failed:'操作失败：',busy:'有未过期作业；等待结束或停止插件任务后重试。',reset:'清空 V2 记忆',resetConfirm:'清空 V2 摘要、笔记、Git 历史及记忆作业？保留原始会话和来源模式。此操作不可撤销。',resetDone:'V2 记忆已清空。',sources:'来源会话',next:'下一页',previous:'上一页',enable:'启用',disable:'停用',ready:'目录已核对',uncertain:'来源资格未核实，整合已暂停',noReasoning:'该模型未声明思考强度',hint:'每阶段可独立选 Provider / 模型；同时留空则使用旧共用配置或继承触发会话。Codex 默认严格使用 Low / Medium，不做别名映射。',policy:'生成开关只决定新会话的初始模式；既有会话在下方启用或停用。历史未记录的 opt-out 无法恢复。',generateMemories:'新会话允许生成记忆',useMemories:'使用记忆摘要',dedicatedTools:'向普通会话开放记忆专用工具',disableOnExternalContext:'新会话使用 Web / MCP 后标记污染',diagnostics:'写脱敏诊断（记忆根之外）',providerLegacy:'旧共用 Provider',modelLegacy:'旧共用模型',minRolloutIdleHours:'抽取前空闲小时数',maxRolloutAgeDays:'按更新时间计算的最大天数',maxRolloutsPerStartup:'每次最多领取会话数',maxRawMemoriesForConsolidation:'整合最大来源数',maxUnusedDays:'未使用来源保留天数',concurrencyLimit:'抽取并发',phase2SuccessCooldownSeconds:'成功整合冷却秒数',agentTimeoutMs:'显式作业超时毫秒（0 为不限）'}
 const en={...zh,nav:'Memory',title:'Codex V2 Memory',save:'Save settings',refresh:'Refresh status',loading:'Loading…',saved:'Saved. New jobs use the new settings.',inherit:'Inherit triggering session',runtime:'Resolved at runtime',unsupported:'Unsupported by this model',legacy:'Preserved legacy value',default:'Default',explicit:'Saved value',stage1:'Extraction',stage2:'Consolidation',provider:'Provider',model:'Model',effort:'Reasoning effort',codex:'Codex default',parent:'Inherit parent effort',providerDefault:'Provider default',failed:'Failed: ',busy:'An unexpired job is running. Wait or stop plugin tasks before retrying.',reset:'Clear V2 memory',resetConfirm:'Clear V2 summaries, notes, Git history and jobs? Original sessions and source modes remain. This cannot be undone.',resetDone:'V2 memory cleared.',sources:'Source sessions',next:'Next page',previous:'Previous page',enable:'Enable',disable:'Disable',ready:'Catalog verified',uncertain:'Source eligibility uncertain; consolidation paused',noReasoning:'No reasoning controls declared',hint:'Select each stage independently. Leave both route fields blank to use the legacy shared route or the triggering session. Codex uses Low / Medium without aliases.',policy:'Generation controls initial modes of new sessions only. Change existing sources below. Historical unrecorded opt-outs cannot be recovered.',generateMemories:'Allow memory generation for new sessions',useMemories:'Use memory summary',dedicatedTools:'Expose dedicated memory tools',disableOnExternalContext:'Mark new sessions polluted after Web / MCP use',diagnostics:'Write redacted diagnostics outside memory root',providerLegacy:'Legacy shared provider',modelLegacy:'Legacy shared model',minRolloutIdleHours:'Idle hours before extraction',maxRolloutAgeDays:'Maximum age since update (days)',maxRolloutsPerStartup:'Sessions per startup',maxRawMemoriesForConsolidation:'Maximum consolidation sources',maxUnusedDays:'Unused source retention (days)',concurrencyLimit:'Extraction concurrency',phase2SuccessCooldownSeconds:'Success cooldown seconds',agentTimeoutMs:'Explicit job timeout milliseconds (0 = none)'}
 const style={font:'inherit',color:'inherit',background:'transparent',border:'1px solid currentColor',borderRadius:6,padding:'6px 8px',maxWidth:'100%'}
 async function request(path,values,signal){
  const response=await fetch(BASE+path,{method:values===undefined?'GET':'POST',headers:values===undefined?{accept:'application/json'}:{'content-type':'application/json'},...values===undefined?{}:{body:JSON.stringify(values)},signal})
  const body=await response.json();if(!response.ok||!body.ok)throw new Error(body.error??`HTTP_${response.status}`);return body
 }
 function RouteFields({stage,values,set,catalog,t,origins}){
  const prefix='stage'+stage,provider=values[prefix+'Provider']||values.provider,model=values[prefix+'Model']||values.model
  const [caps,setCaps]=react.useState(null),[error,setError]=react.useState(null)
  react.useEffect(()=>{
   setCaps(null);setError(null);if(!provider||!model)return
   const controller=new AbortController()
   request('/capabilities?provider='+encodeURIComponent(provider)+'&model='+encodeURIComponent(model),undefined,controller.signal).then(body=>{if(!controller.signal.aborted)setCaps(body)}).catch(e=>{if(!controller.signal.aborted)setError(e.message)})
   return ()=>controller.abort()
  },[provider,model])
  const efforts=(caps?.reasoning?.efforts??[]).map(option=>({value:option.id,label:option.label??option.id}))
  const current=values[prefix+'ReasoningEffort']??'codex',resolved=current==='codex'?stage===1?'low':'medium':current
  const unsupported=caps&&current!=='provider-default'&&current!=='inherit-parent'&&current!==''&&!efforts.some(x=>x.value===resolved)
  const special=[{value:'codex',label:t('codex')+` (${stage===1?'Low':'Medium'})`},{value:'inherit-parent',label:t('parent')},{value:'provider-default',label:t('providerDefault')}]
  if(current==='')special.push({value:'',label:t('parent')+' — '+t('legacy')})
  if(![...special,...efforts].some(x=>x.value===current))special.push({value:current,label:current+' — '+t('unsupported')})
  const groups=catalog?.groups??[],models=groups.find(x=>x.id===provider)?.models??[]
  return h('fieldset',{style:{border:'1px solid #8886',borderRadius:8,padding:12}},h('legend',null,t(prefix)),
   ...[['Provider','provider',groups],['Model','model',models]].map(([suffix,label,list])=>{
    const id='memory-'+prefix+suffix
    return h('label',{key:suffix,style:{display:'grid',gap:4,marginBottom:10}},t(label),h('input',{id,style,list:id+'-options',value:values[prefix+suffix]??'',placeholder:t('inherit'),onChange:e=>set(prefix+suffix,e.target.value)}),h('datalist',{id:id+'-options'},...list.map(x=>h('option',{key:x.id,value:x.id}))))
   }),
   h('label',{style:{display:'grid',gap:4}},t('effort'),h('select',{style,value:current,onChange:e=>set(prefix+'ReasoningEffort',e.target.value)},...[...special,...efforts].map(x=>h('option',{key:x.value,value:x.value},x.label)))),
   h('small',null,t(origins[prefix+'ReasoningEffort']??'default'),' · ',error??(!provider||!model?t('runtime'):unsupported?t('unsupported'):caps?.reasoning?`context: ${caps.context?.contextWindow??'unknown'}`:t('noReasoning'))))
 }
 const numbers=['minRolloutIdleHours','maxRolloutAgeDays','maxRolloutsPerStartup','maxRawMemoriesForConsolidation','maxUnusedDays','concurrencyLimit','phase2SuccessCooldownSeconds','agentTimeoutMs']
 const booleans=['generateMemories','useMemories','dedicatedTools','disableOnExternalContext','diagnostics']
 function Section({t,loadCatalog}){
  const [values,setValues]=react.useState(null),[origins,setOrigins]=react.useState({}),[catalog,setCatalog]=react.useState(null),[message,setMessage]=react.useState(''),[saving,setSaving]=react.useState(false),[status,setStatus]=react.useState(null),[threads,setThreads]=react.useState([]),[cursor,setCursor]=react.useState(0),[next,setNext]=react.useState(null)
  const fail=error=>setMessage(t('failed')+(error.message==='reset_busy'?t('busy'):error.message))
  async function refresh(offset=cursor){
   const [state,page]=await Promise.all([request('/status'),request('/threads?cursor='+offset)])
   setStatus(state);setThreads(page.items);setCursor(offset);setNext(page.nextCursor)
  }
  react.useEffect(()=>{
   let alive=true
   request('/config').then(body=>{if(alive){setValues(body.values);setOrigins(body.origins??{})}}).catch(e=>alive&&fail(e))
   loadCatalog().then(body=>{if(alive){if(!body.ok)throw new Error(body.error??'MODEL_CATALOG_FAILED');setCatalog(body.value)}}).catch(e=>alive&&fail(e))
   // Status refresh is user-driven after this initial fetch; there is no polling.
   Promise.all([request('/status'),request('/threads')]).then(([state,page])=>{if(alive){setStatus(state);setThreads(page.items);setNext(page.nextCursor)}}).catch(e=>alive&&fail(e))
   return ()=>{alive=false}
  },[])
  const set=(key,value)=>{setValues(old=>({...old,[key]:value}));setMessage('')}
  async function save(){
   setSaving(true)
   try{
    const outgoing={...values}
    for(const key of numbers){if(outgoing[key]==='')throw new Error(key+' required');outgoing[key]=Number(outgoing[key]);if(!Number.isSafeInteger(outgoing[key])||outgoing[key]<0)throw new Error(key+' invalid')}
    const body=await request('/config',{values:outgoing});setValues(body.values);setOrigins(body.origins??{});setMessage(t('saved'))
   }catch(error){fail(error)}finally{setSaving(false)}
  }
  async function mode(sessionId,value){try{await request('/thread-mode',{sessionId,mode:value});await refresh()}catch(error){fail(error)}}
  async function reset(){if(!window.confirm(t('resetConfirm')))return;try{await request('/reset',{confirm:'clear-v2-memory'});await refresh(0);setMessage(t('resetDone'))}catch(error){fail(error)}}
  if(!values)return h('div',null,h('p',null,t('loading')),h('p',{role:'alert'},message))
  const rows=threads.map(row=>h('tr',{key:row.sessionId},h('td',null,row.sessionId),h('td',null,row.memoryMode+' / '+row.modeOrigin),h('td',null,row.presence+' / '+row.readStatus),h('td',null,h('button',{type:'button',style,onClick:()=>mode(row.sessionId,row.memoryMode==='enabled'?'disabled':'enabled')},t(row.memoryMode==='enabled'?'disable':'enable')))))
  return h('div',{style:{display:'grid',gap:12,maxWidth:760}},h('h3',null,t('title')),h('p',null,t('hint')),
   h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(250px,1fr))',gap:12}},...[1,2].map(stage=>h(RouteFields,{key:stage,stage,values,set,catalog,t,origins}))),
   h('details',null,h('summary',null,t('providerLegacy')+' / '+t('modelLegacy')), ...['provider','model'].map(key=>h('label',{key,style:{display:'grid',gap:4}},t(key+'Legacy'),h('input',{style,value:values[key]??'',placeholder:t('inherit'),onChange:e=>set(key,e.target.value)})))),
   h('p',null,t('policy')),
   ...booleans.map(key=>h('label',{key},h('input',{type:'checkbox',checked:values[key]===true,onChange:e=>set(key,e.target.checked)}),' ',t(key))),
   h('details',null,h('summary',null,'Limits'),...numbers.map(key=>h('label',{key,style:{display:'grid',gap:4,margin:'8px 0'}},t(key),h('input',{type:'number',min:0,step:1,style,value:values[key],onChange:e=>set(key,e.target.value)})))),
   h('button',{type:'button',style,disabled:saving,onClick:save},t('save')),h('p',{role:'status','aria-live':'polite'},message),
   h('div',null,h('button',{type:'button',style,onClick:()=>refresh().catch(fail)},t('refresh')),' ',h('button',{type:'button',style,onClick:reset},t('reset'))),
   status?h('p',null,status.control.reset_pending?'reset pending':status.control.catalog_ready?t('ready'):t('uncertain'),' · running: '+status.running+' · max sources: '+status.progress.max_thread_count):null,
   status?.jobs.length?h('ul',null,...status.jobs.map(job=>h('li',{key:job.kind+job.job_key},job.kind+' / '+job.job_key+': '+job.status+(job.last_error?' — '+job.last_error:'')))):null,
   h('h4',null,t('sources')),h('div',{style:{overflowX:'auto'}},h('table',null,h('tbody',null,...rows))),
   h('div',null,cursor>0?h('button',{type:'button',onClick:()=>refresh(Math.max(0,cursor-200)).catch(fail)},t('previous')):null,next!==null?h('button',{type:'button',onClick:()=>refresh(Number(next)).catch(fail)},t('next')):null))
 }
 return {inject:['slots','locale','remote','remote.session'],apply(ctx){
  const t=ctx.locale.bind(NS)
  ctx.effect(()=>ctx.locale.register(NS,{zh,en}),'memory: dictionaries')
  ctx.slots.inject('settings.section',function*(){yield ctx.slots.register({name:'settings.section',id:'codex-memory',order:35,label:()=>t('nav'),locale:NS,inject:()=>({t,loadCatalog:()=>ctx.remote.session.modelCatalog()})},Section)})
 }}
}})
