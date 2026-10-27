import {spawnSync} from 'node:child_process'
import {existsSync,readdirSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
const directory=fileURLToPath(new URL('.',import.meta.url))
const desktop='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const executable=process.env.DSH_TEST_RUNTIME??(process.platform==='darwin'&&existsSync(desktop)?desktop:process.execPath)
const env={...process.env,ELECTRON_RUN_AS_NODE:'1'}
const tests=readdirSync(directory).filter(name=>/^task[1-6](?:-[a-z]+)?\.test\.mjs$/.test(name)).sort()
for(const args of [['--expose-internals','--test',...tests],['verify-prompts.mjs']]){
 const result=spawnSync(executable,args,{cwd:directory,env,stdio:'inherit'})
 if(result.error)throw new Error('memory verification runtime failed',{cause:result.error})
 if(result.status!==0)process.exit(result.status??1)
}
