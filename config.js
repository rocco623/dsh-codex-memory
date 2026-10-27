export const DEFAULTS={
 generateMemories:true,useMemories:true,dedicatedTools:false,disableOnExternalContext:false,
 maxRawMemoriesForConsolidation:256,maxUnusedDays:30,maxRolloutAgeDays:10,maxRolloutsPerStartup:2,minRolloutIdleHours:6,
 concurrencyLimit:8,stage1LeaseSeconds:3600,stage1RetryDelaySeconds:3600,stage1PruneBatch:200,
 phase2LeaseSeconds:3600,phase2RetryDelaySeconds:3600,phase2HeartbeatSeconds:90,phase2SuccessCooldownSeconds:21600,
 agentTimeoutMs:0,provider:'',model:'',stage1Provider:'',stage1Model:'',stage2Provider:'',stage2Model:'',
 stage1ReasoningEffort:'codex',stage2ReasoningEffort:'codex',diagnostics:true,memoryConfigVersion:2,
}
export const configError=(code,cause)=>Object.assign(new Error(`memory configuration ${code}`,{cause}),{code})
export function normalizeOptions(raw={}, {strict=false}={}){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw configError('INVALID_CONFIG')
 if(strict&&Object.keys(raw).some(key=>!Object.hasOwn(DEFAULTS,key)))throw configError('UNKNOWN_CONFIG_FIELD')
 const result={...DEFAULTS}
 for(const key of Object.keys(DEFAULTS))if(Object.hasOwn(raw,key)&&raw[key]!==undefined){
  const value=raw[key],kind=typeof DEFAULTS[key]
  if(typeof value!==kind||kind==='number'&&(!Number.isSafeInteger(value)||value<0))throw configError('INVALID_CONFIG_FIELD')
  result[key]=value
 }
 if(result.concurrencyLimit<1||result.stage1LeaseSeconds<1||result.phase2LeaseSeconds<1||result.phase2HeartbeatSeconds<1||result.agentTimeoutMs>2147483647||result.phase2HeartbeatSeconds>Math.floor(2147483647/1000))throw configError('INVALID_LIFECYCLE_LIMIT')
 for(const stage of [1,2]){
  const prefix=`stage${stage}`,p=result[prefix+'Provider'],m=result[prefix+'Model']
  if(Boolean(p)!==Boolean(m))throw configError('INCOMPLETE_ROUTE')
  result[prefix+'Provider']=p;result[prefix+'Model']=m
 }
 return result
}
export function stageRoute(options,stage,parent={}){
 const prefix=`stage${stage}`,own=options[prefix+'Provider']
 const provider=own||options.provider||parent.provider,model=own?options[prefix+'Model']:options.model||parent.model
 if(!provider||!model)throw configError('NO_TRIGGER_ROUTE')
 let effort=options[prefix+'ReasoningEffort']
 if(effort==='codex')effort=stage===1?'low':'medium'
 if(effort===''||effort==='inherit-parent')effort=parent.reasoningEffort
 if(effort==='provider-default')effort=undefined
 return {provider,model,...effort===undefined?{}:{reasoningEffort:effort}}
}
export function configOrigins(raw={}){
 return Object.fromEntries(Object.keys(DEFAULTS).map(key=>[key,Object.hasOwn(raw,key)&&raw[key]!==undefined?raw.memoryConfigVersion===2?'explicit':'legacy':'default']))
}
