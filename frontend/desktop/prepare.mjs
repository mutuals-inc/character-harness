import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import platform from './platform.cjs';
const root=path.resolve(import.meta.dirname,'../..');
const target=platform.buildPlatform();
const build=path.join(root,'player/hz',process.platform==='win32'?'hzbuild.exe':'hzbuild');
if(!existsSync(build))throw new Error('Restore the licensed Kaigen SDK for player/ before building the desktop app.');
for(const [command,args,cwd] of [
  [process.execPath,[path.join(root,'frontend/node_modules/typescript/bin/tsc'),'--noEmit'],path.join(root,'frontend')],
  [process.execPath,[path.join(root,'frontend/node_modules/vite/bin/vite.js'),'build'],path.join(root,'frontend')],
  [build,[target],path.join(root,'player')],
]) {
  const result=spawnSync(command,args,{cwd,stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
