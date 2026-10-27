import { createMemoryBackend, memoryError, strictFields } from './memory-backend.js'

const string = { type:'string' }
const integer = { type:'integer', minimum:0 }
const matchMode = { oneOf:[
  {type:'object',properties:{type:{const:'any'}},required:['type'],additionalProperties:false},
  {type:'object',properties:{type:{const:'all_on_same_line'}},required:['type'],additionalProperties:false},
  {type:'object',properties:{type:{const:'all_within_lines'},line_count:{type:'integer',minimum:1}},required:['type','line_count'],additionalProperties:false},
] }
const definitions = [
  ['list', 'List memory workspace entries.', {path:string,cursor:string,max_results:integer}, []],
  ['read', 'Read memory workspace text.', {path:string,line_offset:{type:'integer',minimum:1},max_lines:{type:'integer',minimum:1}}, ['path']],
  ['search', 'Search memory workspace text.', {queries:{type:'array',items:string,minItems:1},path:string,match_mode:matchMode,context_lines:integer,cursor:string,max_results:integer,case_sensitive:{type:'boolean'},normalized:{type:'boolean'}}, ['queries']],
  ['write', 'Atomically write a workspace file.', {path:string,content:string}, ['path','content']],
  ['edit', 'Replace exact text in a workspace file.', {path:string,old_string:string,new_string:string,replace_all:{type:'boolean'}}, ['path','old_string','new_string']],
  ['remove', 'Remove a workspace file or empty directory.', {path:string}, ['path']],
  ['move', 'Move a workspace path without overwriting.', {source:string,destination:string}, ['source','destination']],
]

export function createPrivateWorkspaceTools(root, options = {}) {
  const backend = createMemoryBackend(root, {...options,privatePaths:true})
  const tools = definitions.map(([method,description,properties,required])=>({
    name:`memory_workspace_${method}`, description,
    parameters:{type:'object',properties,required,additionalProperties:false},
  }))
  const dispatch = (name,args) => {
    const definition=definitions.find(([method])=>`memory_workspace_${method}`===name)
    if(!definition) throw memoryError('UnknownTool','unknown memory workspace tool')
    const [method,,properties,required]=definition
    strictFields(args,Object.keys(properties))
    for(const key of required) if(args[key]===undefined) throw memoryError('InvalidArgument',`missing ${key}`)
    for(const [key,value] of Object.entries(args)) {
      const schema=properties[key]
      if(schema.type==='string'&&typeof value!=='string' || schema.type==='boolean'&&typeof value!=='boolean' || schema.type==='integer'&&(!Number.isSafeInteger(value)||value<schema.minimum)) throw memoryError('InvalidArgument',`invalid ${key}`)
    }
    return backend[method](args)
  }
  return {tools,dispatch}
}
