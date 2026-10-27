const trim=text=>text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu,'')
const block=(text,name)=>{const start=text.indexOf(`<${name}>`);if(start<0)return null;const end=text.indexOf(`</${name}>`,start);return end<0?null:text.slice(start+name.length+2,end)}
const u32=text=>{text=trim(text);if(!/^\+?\d+$/.test(text))return null;const n=Number(text);return Number.isInteger(n)&&n<=4294967295?n:null}
function parseEntry(line){
 line=trim(line);const noteAt=line.lastIndexOf('|note=[')
 if(noteAt<0||!line.endsWith(']'))return null
 const location=line.slice(0,noteAt),colon=location.lastIndexOf(':');if(colon<0)return null
 const range=location.slice(colon+1),dash=range.indexOf('-');if(dash<0)return null
 const start=u32(range.slice(0,dash)),end=u32(range.slice(dash+1));if(start===null||end===null)return null
 return {path:trim(location.slice(0,colon)),lineStart:start,lineEnd:end,note:trim(line.slice(noteAt+7,-1))}
}
/** Only actual outer blocks drive usage; bare examples and tags are inert. */
export function parseMemoryCitation(texts){
 const entries=[],rolloutIds=[],seen=new Set()
 for(const text of texts){
  if(typeof text!=='string')continue
  for(const match of text.matchAll(/<oai-mem-citation>([\s\S]*?)<\/oai-mem-citation>/g)){
   const body=match[1],raw=block(body,'citation_entries')
   if(raw!==null)for(const line of raw.split('\n')){const entry=parseEntry(line);if(entry)entries.push(entry)}
   const ids=block(body,'rollout_ids')??block(body,'thread_ids')
   if(ids!==null)for(const line of ids.split('\n')){const id=trim(line);if(id&&!seen.has(id)){seen.add(id);rolloutIds.push(id)}}
  }
 }
 return entries.length||rolloutIds.length?{entries,rolloutIds}:null
}
