// Integration check against a running desktop server; uses no provider services.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdirSync,openSync,closeSync} from 'node:fs';
import path from 'node:path';
import {WebSocketServer} from 'ws';
import platform from './platform.cjs';
import protocol from './protocol.cjs';

const root=path.resolve(import.meta.dirname,'../..');
const id=process.argv[2];
if(!id || !/^[a-z0-9_-]+$/i.test(id))throw new Error('Usage: node desktop/smoke.mjs <character-id>');
const origin=`http://127.0.0.1:${process.env.STUDIO_DESKTOP_PORT ?? 4174}`;
const opened=await fetch(origin);
const cookie=opened.headers.get('set-cookie')?.split(';')[0];
const response=await fetch(`${origin}/api/native-stage?character=${encodeURIComponent(id)}`,{headers:{Cookie:cookie ?? ''}});
const config=await response.json();
if(!response.ok)throw new Error(config.error ?? 'Character preparation failed.');
const token=randomBytes(24).toString('hex');
const bridge=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:protocol.MAX_FRAME_BYTES});
await new Promise(resolve=>bridge.once('listening',resolve));
let player,frames=0,opaque=0;
try {
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`Native preview timed out after ${frames} frames.`)),45000);
    bridge.on('connection',(socket,request)=>{
      if(request.url!==`/${token}`){socket.close();return;}
      socket.on('error',reject);
      socket.send(JSON.stringify({t:'state',width:800,height:600,mouth:0.5,talking:true}));
      socket.on('message',(data,binary)=>{
        if(!binary || !protocol.validFrame(data))return;
        frames++;
        opaque=0;
        for(let i=11;i<data.length;i+=4)if(data[i]>0)opaque++;
        socket.send(JSON.stringify({t:'frame-ready'}));
        if(frames>=12 && opaque>100){clearTimeout(timer);resolve();}
      });
    });
    const folder=path.join(root,'.cache/frontend/desktop');mkdirSync(folder,{recursive:true});
    const log=openSync(path.join(folder,`smoke-${id}.log`),'w');
    player=spawn(platform.playerExecutable(root),[],{cwd:path.join(root,'player'),windowsHide:true,
      env:{...platform.childEnvironment(),HARNESS_CHARACTER:config.character,HARNESS_STUDIO_URL:`ws://127.0.0.1:${bridge.address().port}/${token}`},stdio:['ignore',log,log]});
    closeSync(log);
    player.once('error',error=>{clearTimeout(timer);reject(error);});
    player.once('exit',()=>{if(frames<12){clearTimeout(timer);reject(new Error('Native player exited early.'));}});
  });
  console.log(JSON.stringify({character:id,frames,visiblePixels:opaque,transport:'localhost WebSocket'}));
} finally {
  player?.kill();
  for(const client of bridge.clients)client.terminate();
  bridge.close();
}
