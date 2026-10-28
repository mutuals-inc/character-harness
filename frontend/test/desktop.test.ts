import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {buildPlatform, playerExecutable, childEnvironment} = require('../desktop/platform.cjs');
const {validFrame, stageState} = require('../desktop/protocol.cjs');

test('desktop resolves Windows and macOS builds and never forwards provider keys', () => {
  assert.equal(buildPlatform('win32'), 'windows');
  assert.equal(buildPlatform('darwin'), 'macos');
  assert.throws(()=>buildPlatform('linux'), /Windows and macOS/);
  assert.deepEqual(childEnvironment({PATH:'bin',HOME:'home',TMPDIR:'temp',XAI_API_KEY:'secret',ELEVENLABS_API_KEY:'secret',HARNESS_URL:'external'}),
    {PATH:'bin',HOME:'home',TMPDIR:'temp'});
  const root=mkdtempSync(path.join(tmpdir(),'studio-platform-'));
  try {
    assert.equal(playerExecutable(root,'win32'),path.join(root,'player/out/windows/debug/CharacterPlayer.exe'));
    const bundle=path.join(root,'player/out/macos/debug/Character Player.app/Contents/MacOS');
    mkdirSync(bundle,{recursive:true});
    writeFileSync(path.join(bundle,'CharacterPlayer'),'');
    assert.equal(playerExecutable(root,'darwin'),path.join(bundle,'CharacterPlayer'));
    writeFileSync(path.join(root,'player/out/macos/debug/CharacterPlayer'),'');
    assert.equal(playerExecutable(root,'darwin'),path.join(root,'player/out/macos/debug/CharacterPlayer'));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('native bridge rejects malformed frames and bounds renderer commands', () => {
  const frame=Buffer.alloc(8+240*320*4);
  frame.writeUInt32LE(240,0);frame.writeUInt32LE(320,4);
  assert.ok(validFrame(frame));
  assert.equal(validFrame(frame.subarray(0,-1)),false);
  assert.equal(validFrame(Buffer.alloc(7)),false);
  frame.writeUInt32LE(0xffffffff,0);
  assert.equal(validFrame(frame),false);
  assert.deepEqual(stageState({width:Infinity,height:-1,mouth:NaN,talking:'yes'}),
    {t:'state',width:960,height:240,mouth:0,talking:false});
  assert.deepEqual(stageState({width:100000,height:100000,mouth:10,talking:true}),
    {t:'state',width:1280,height:1280,mouth:1,talking:true});
});
