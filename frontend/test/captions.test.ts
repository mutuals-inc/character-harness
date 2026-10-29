import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Captions} from '../src/audio/captions.ts';

test('captions follow the audio clock, wrap into readable phrases and clear on interruption',()=>{
  const captions=new Captions();
  const text='This sentence arrives long before it is spoken. We should read this second part only when the audio gets there.';
  captions.push(1,{characters:[...text],character_start_times_seconds:[...text].map((_,i)=>i/10),character_end_times_seconds:[...text].map((_,i)=>(i+1)/10)});
  assert.equal(captions.text(()=>null),'');
  assert.equal(captions.text(()=>-1),'');
  assert.equal(captions.text(()=>1),'This sentence arrives long before it is spoken.');
  const second=captions.text(()=>8);
  assert.match(second,/second part/);
  assert.ok(second.length<=76);
  captions.push(2,{characters:['Next sentence.'],character_start_times_seconds:[0],character_end_times_seconds:[2]});
  assert.equal(captions.text(id=>id===2 ? -2 : 1),'This sentence arrives long before it is spoken.');
  assert.equal(captions.text(id=>id===2 ? 1 : 20),'Next sentence.');
  assert.equal(captions.text(()=>50),'');
  captions.clear();
  assert.equal(captions.text(()=>1),'');
});


test('captions hide voice delivery tags without moving audio timestamps',()=>{
  const captions=new Captions();
  captions.push(1,{characters:[...'[teasing] Hello there.'],character_start_times_seconds:Array.from({length:22},(_,i)=>i/10),character_end_times_seconds:Array.from({length:22},(_,i)=>(i+1)/10)});
  assert.equal(captions.text(()=>1),'Hello there.');
});
