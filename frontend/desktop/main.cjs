const { app, BrowserWindow, ipcMain, session } = require('electron');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, openSync, closeSync } = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { playerExecutable, childEnvironment } = require('./platform.cjs');
const {validFrame, stageState, MAX_FRAME_BYTES} = require('./protocol.cjs');

app.setName('Mutuals Character Studio');
app.setPath('userData',path.join(app.getPath('appData'),'Mutuals Character Studio'));
const ownsInstance=app.requestSingleInstanceLock();
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});

const root = path.resolve(__dirname, '../..');
let backend, player, bridge, nativeSocket, window, origin;
let generation = 0;
let lastState = stageState({});
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

function trusted(event) {
  return event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.startsWith(origin+'/');
}
function stopPlayer() {
  nativeSocket?.close(); nativeSocket = null;
  player?.kill(); player = null;
  bridge?.close(); bridge = null;
}
function send(value) { if (nativeSocket?.readyState === 1) nativeSocket.send(JSON.stringify(value)); }

async function launchCharacter(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(id)) throw new Error('Invalid character.');
  const current = ++generation;
  let receivedCharacterFrame=false;
  stopPlayer();
  const cookies = await session.defaultSession.cookies.get({url:origin});
  const response = await fetch(`${origin}/api/native-stage?character=${encodeURIComponent(id)}`, {headers:{Cookie:cookies.map(c=>`${c.name}=${c.value}`).join('; ')}});
  const config = await response.json();
  if (!response.ok) throw new Error(config.error ?? 'Could not prepare the native character.');
  if (current !== generation) return;
  const executable = playerExecutable(root);
  if (!existsSync(executable)) throw new Error('Build the Kaigen player with npm run desktop:prepare first.');
  const token = randomBytes(24).toString('hex');
  const connection = new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:MAX_FRAME_BYTES});
  bridge = connection;
  await new Promise((resolve,reject)=>{connection.once('listening',resolve);connection.once('error',reject);});
  if(current!==generation){connection.close();return;}
  connection.on('connection',(socket,request)=>{
    socket.on('error',()=>socket.close());
    if (current!==generation || request.url !== `/${token}` || request.headers.origin !== undefined) {socket.close();return;}
    nativeSocket?.close(); nativeSocket = socket; send(lastState);
    socket.on('message',(data,binary)=>{
      if(current===generation && binary && validFrame(data) && window && !window.isDestroyed()) {
        if(!receivedCharacterFrame)for(let i=11;i<data.length;i+=4)if(data[i]>0){receivedCharacterFrame=true;break;}
        window.webContents.send('native-stage:frame',data);
      }
    });
    socket.on('close',()=>{if(nativeSocket===socket) nativeSocket=null;});
  });
  const logFile = path.join(root,'.cache/frontend/desktop/player.log');
  mkdirSync(path.dirname(logFile),{recursive:true});
  const log = openSync(logFile,'w');
  player = spawn(executable,[],{cwd:path.join(root,'player'),windowsHide:true,
    env:{...childEnvironment(),HARNESS_CHARACTER:config.character,HARNESS_STUDIO_URL:`ws://127.0.0.1:${connection.address().port}/${token}`},stdio:['ignore',log,log]});
  closeSync(log);
  const launched = player;
  let failure;
  launched.on('error',error=>{failure=error;});
  for(let attempt=0;attempt<1200;attempt++) {
    if(current!==generation) return;
    if(failure) throw failure;
    if(launched.exitCode!==null) throw new Error('Kaigen closed during startup. See .cache/frontend/desktop/player.log.');
    if(receivedCharacterFrame) return;
    await pause(50);
  }
  stopPlayer();
  throw new Error('Kaigen could not render this character in time. See .cache/frontend/desktop/player.log.');
}

async function start() {
  const server = createServer();
  const configuredPort=Number(process.env.STUDIO_DESKTOP_PORT ?? 4174);
  if(!Number.isInteger(configuredPort)||configuredPort<1024||configuredPort>65535)throw new Error('Invalid STUDIO_DESKTOP_PORT.');
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(configuredPort,'127.0.0.1',resolve);});
  const port=server.address().port; await new Promise(resolve=>server.close(resolve));
  origin=`http://127.0.0.1:${port}`;
  const logFile=path.join(root,'.cache/frontend/desktop/server.log'); mkdirSync(path.dirname(logFile),{recursive:true});
  const log=openSync(logFile,'w');
  backend=spawn(process.execPath,[path.join(root,'frontend/server/index.ts'),'--production'],{cwd:path.join(root,'frontend'),windowsHide:true,
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1',FRONTEND_PORT:String(port)},stdio:['ignore',log,log]}); closeSync(log);
  for(let i=0;i<100;i++){try{if((await fetch(origin)).ok)break;}catch{} if(backend.exitCode!==null)throw new Error('The local Studio server could not start.');await pause(100);}
  window=new BrowserWindow({title:'Character Studio',width:1360,height:900,minWidth:900,minHeight:650,show:true,autoHideMenuBar:true,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(origin+'/'))event.preventDefault();});
  window.on('closed',()=>{++generation;stopPlayer();window=null;app.quit();});
  ipcMain.handle('native-stage:load',(event,id)=>{if(!trusted(event))throw new Error('Untrusted renderer.');return launchCharacter(id);});
  ipcMain.on('native-stage:frame-ready',event=>{if(trusted(event))send({t:'frame-ready'});});
  ipcMain.on('native-stage:state',(event,value)=>{
    if(!trusted(event)||!value)return;
    lastState=stageState(value);send(lastState);
  });
  ipcMain.on('native-stage:cue',(event,value)=>{
    if(!trusted(event)||!value)return;
    const safe={t:'cue'};
    for(const key of ['emotion','gesture','camera','talk'])if(typeof value[key]==='string'&&value[key].length<=64)safe[key]=value[key];
    send(safe);
  });
  await window.loadURL(origin);window.show();
}
if(ownsInstance) app.whenReady().then(start).catch(error=>{console.error(error);app.quit();});
else app.quit();
app.on('before-quit',()=>{++generation;stopPlayer();bridge?.close();backend?.kill();});
app.on('window-all-closed',()=>app.quit());
