interface Alignment {
  characters?: string[];
  character_start_times_seconds?: number[];
  character_end_times_seconds?: number[];
}

export class Captions {
  private clips = new Map<number, {text:string; start:number; end:number}[]>();

  push(id:number, alignment:Alignment) {
    const clip=this.clips.get(id) ?? [];
    const chars=alignment.characters ?? [], starts=alignment.character_start_times_seconds ?? [];
    for(let i=0;i<Math.min(chars.length,starts.length,10000);i++) {
      const start=starts[i],end=alignment.character_end_times_seconds?.[i] ?? start;
      if(typeof chars[i]==='string' && Number.isFinite(start) && Number.isFinite(end) && start>=0 && end>=start && clip.length<20000)
        clip.push({text:chars[i],start,end});
    }
    this.clips.set(id,clip);
    if(this.clips.size>64)this.clips.delete(this.clips.keys().next().value!);
  }

  text(position:(id:number)=>number|null):string {
    for(const [id,chars] of [...this.clips].reverse()) {
      const time=position(id);
      if(time===null || time<0 || !chars.length)continue;
      let start=0;
      while(start<chars.length) {
        let end=start,length=0;
        while(end<chars.length && length<76) {
          length+=chars[end++].text.length;
          if(length>=40 && /[.!?。！？]\s*$/u.test(chars[end-1].text))break;
        }
        // Prefer a word boundary, while still bounding unbroken/CJK text.
        if(end<chars.length && !/\s/u.test(chars[end-1].text)) {
          let boundary=end;
          while(boundary>start+40 && !/\s/u.test(chars[boundary-1].text))boundary--;
          if(boundary>start+40)end=boundary;
        }
        const until=end<chars.length ? chars[end].start : chars[end-1].end+0.8;
        if(time>=chars[start].start && time<until)return chars.slice(start,end).map(c=>c.text).join('').replace(/\[[^\]]+\]/g,'').trim();
        start=end;
      }
    }
    return '';
  }

  clear(){this.clips.clear();}
}
