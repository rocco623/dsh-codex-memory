import {spawnSync} from 'node:child_process'
import {readdirSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
const cwd=fileURLToPath(new URL('.',import.meta.url))
for(const file of readdirSync(cwd).filter(name=>/\.(?:js|mjs)$/.test(name))){
 const result=spawnSync(process.execPath,['--check',file],{cwd,stdio:'inherit'})
 if(result.error)throw new Error('syntax checker failed',{cause:result.error})
 if(result.status!==0)process.exit(result.status??1)
}
