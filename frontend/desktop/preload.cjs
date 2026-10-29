const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nativeStudio', {
  load: character => ipcRenderer.invoke('native-stage:load', character),
  onFrame: callback => {
    const listener = (_event, bytes) => callback(bytes);
    ipcRenderer.on('native-stage:frame', listener);
    return () => ipcRenderer.removeListener('native-stage:frame', listener);
  },
  frameReady: () => ipcRenderer.send('native-stage:frame-ready'),
  state: value => ipcRenderer.send('native-stage:state', value),
  cue: value => ipcRenderer.send('native-stage:cue', value),
});
