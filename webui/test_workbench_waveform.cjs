'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'workbench_static/app.js'), 'utf8');
const context = vm.createContext({Blob, DataView, Float32Array});
vm.runInContext(source.slice(source.indexOf('async function wavWaveformData('), source.indexOf('function waveformData(')), context);

function wav({bits=16, encoding=1, frames=1600, channels=2, extended=false}={}) {
  const bytes=bits/8, formatSize=extended?40:16, start=28+formatSize;
  const buffer=Buffer.alloc(start+frames*channels*bytes);
  buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);
  buffer.writeUInt32LE(formatSize,16);buffer.writeUInt16LE(extended?0xfffe:encoding,20);
  buffer.writeUInt16LE(channels,22);buffer.writeUInt32LE(16000,24);
  buffer.writeUInt32LE(16000*channels*bytes,28);buffer.writeUInt16LE(channels*bytes,32);buffer.writeUInt16LE(bits,34);
  if(extended){buffer.writeUInt16LE(22,36);buffer.writeUInt16LE(bits,38);buffer.writeUInt16LE(encoding,44);}
  buffer.write('data',start-8);buffer.writeUInt32LE(frames*channels*bytes,start-4);
  if(bits===8)buffer.fill(128,start);
  const position=start+(frames*channels-1)*bytes;
  if(encoding===3){if(bits===32)buffer.writeFloatLE(-.5,position);else buffer.writeDoubleLE(-.5,position);}
  else if(bits===8)buffer.writeUInt8(64,position);
  else buffer.writeIntLE(-(2**(bits-2)),position,bytes);
  return new Blob([buffer]);
}

(async()=>{
  for(const options of [{bits:8},{bits:16},{bits:24},{bits:32},{bits:32,encoding:3},{bits:64,encoding:3},{bits:32,encoding:3,extended:true}]){
    const result=await context.wavWaveformData(wav(options));
    assert.equal(result.duration,.1);
    assert.equal(result.peaks.length,320);
    assert.equal(result.peaks[319],.5);
    assert.equal(result.peaks[0],0);
  }
  const large=wav({frames:10*1024*1024});
  assert.ok(large.size>32*1024*1024);
  const originalSlice=large.slice.bind(large);
  large.arrayBuffer=()=>{throw new Error('Must not read the entire large WAV');};
  large.slice=(start,end)=>{assert.ok(end-start<=1024*1024);return originalSlice(start,end);};
  const result=await context.wavWaveformData(large);
  assert.ok(result.duration>600);
  assert.equal(Math.max(...result.peaks),.5);
  assert.equal(await context.wavWaveformData(new Blob(['not a wav'])),null);
  const truncated=wav().slice(0,50);
  await assert.rejects(context.wavWaveformData(truncated));
  console.log('PASS WAV waveform: PCM/float/extensible, stereo, >32 MB, >10 minutes, bounded reads, invalid input');
})().catch(error=>{console.error(error);process.exitCode=1;});
