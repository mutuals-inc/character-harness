import { $, toast } from '../lib/dom.ts';
import { output } from '../session.ts';
import type { CharacterInfo, WireMessage } from '../types.ts';

interface NativeStudio {
  load(character: string): Promise<void>;
  onFrame(callback:(bytes:Uint8Array)=>void):()=>void;
  frameReady():void;
  state(value: {mouth:number; talking:boolean; width:number; height:number}): void;
  cue(value: WireMessage): void;

}
declare global { interface Window { nativeStudio?: NativeStudio; } }

export class NativeStage {
  private container: HTMLElement;
  private frame=0;
  private disposed=false;
  private unsubscribe:()=>void;
  private lastStateAt=0;

  constructor(container:HTMLElement) {
    this.container=container;
    const canvas=document.createElement('canvas');
    canvas.width=960; canvas.height=720;
    canvas.style.cssText='width:100%;height:100%;object-fit:contain;display:block';
    container.replaceChildren(canvas);
    const context=canvas.getContext('2d');
    if(!context)throw new Error('Canvas rendering is unavailable.');
    this.unsubscribe=window.nativeStudio!.onFrame(bytes=>{
      if(bytes.byteLength<8){window.nativeStudio!.frameReady();return;}
      const header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      const width=header.getUint32(0,true),height=header.getUint32(4,true);
      if(width>=240 && height>=240 && width<=1280 && height<=1280 && bytes.byteLength===8+width*height*4){
        if(canvas.width!==width || canvas.height!==height){canvas.width=width;canvas.height=height;}
        context.putImageData(new ImageData(new Uint8ClampedArray(bytes.slice(8)),width,height),0,0);
      }
      window.nativeStudio!.frameReady();
    });
    container.closest('.stage')!.classList.add('native-stage');
    container.setAttribute('role','img');
    container.setAttribute('aria-label','Native Kaigen character renderer');
    document.addEventListener('stage-cue',this.onCue);
    this.tick();
  }
  async load(character:CharacterInfo) {
    $('#stage-loading').hidden=false;
    $('#stage-loading').textContent='Starting native renderer…';
    try {
      await window.nativeStudio!.load(character.id);
      if(!this.disposed)$('#stage-loading').hidden=true;
    } catch(error) {
      if(this.disposed)return;
      $('#stage-loading').textContent=error instanceof Error ? error.message : 'The native renderer could not start.';
      toast('Could not start Kaigen. See the native renderer message.',true);
    }
  }
  private onCue=(event:Event)=>window.nativeStudio!.cue((event as CustomEvent<WireMessage>).detail);
  gesture(name:string) { window.nativeStudio!.cue({t:'cue',gesture:name}); }
  private tick=()=>{
    if(this.disposed)return;
    const now=performance.now();
    if(now-this.lastStateAt>=33){
      const rect=this.container.getBoundingClientRect();
      const scale=Math.min(devicePixelRatio,1280/Math.max(1,rect.width,rect.height));
      window.nativeStudio!.state({width:rect.width*scale,height:rect.height*scale,mouth:Math.min(1,output.level()*5),talking:output.playing});
      this.lastStateAt=now;
    }
    this.frame=requestAnimationFrame(this.tick);
  };
  dispose(){this.disposed=true;cancelAnimationFrame(this.frame);this.unsubscribe();document.removeEventListener('stage-cue',this.onCue);}
}
