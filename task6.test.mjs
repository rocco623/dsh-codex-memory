import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const pkg=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8'))
test('package ships every runtime module and declares host SDK dependencies',()=>{
 for(const file of ['index.js','client.js','config.js','pipeline.js','model.js','rollout-input.js','sources.js','memory-backend.js','private-workspace-tools.js'])assert.ok(pkg.files.includes(file),`${file} missing from package`)
 for(const file of pkg.files.filter(x=>x.endsWith('.js'))){
  const text=readFileSync(new URL(file,import.meta.url),'utf8')
  for(const match of text.matchAll(/from ['"]\.\/([^'"]+\.js)['"]/g))assert.ok(pkg.files.includes(match[1]),`${file} imports unshipped ${match[1]}`)
 }
 for(const name of ['dsh-llm','dsh-session-format','dsh-session-format-v3-to-v4'])assert.equal((pkg.peerDependencies??{})['@deepseek-ai/'+name],'0.2.1-rc.3')
 assert.equal(pkg.engines.node,'>=24.21.0');assert.equal(pkg.scripts.test,'node selftest.mjs')
})
