import assert from 'node:assert/strict';
import test from 'node:test';
import { S2sWsRealtimeClient } from './realtime_static/ws/s2s-ws-client.js';

globalThis.WebSocket = { OPEN: 1 };

function clientForText() {
  const client = new S2sWsRealtimeClient({ directUrl: 'ws://localhost/v1/realtime', textOnly: true });
  client._ws = { readyState: 1, send() {} };
  client._sessionConfigured = true;
  client._setStatus = value => { client._status = value; };
  client._clearPlaybackState = () => {};
  return client;
}

function message(client, event) { client._onWsMessage(JSON.stringify(event)); }

test('closing releases microphone before AudioContext finishes closing', async () => {
  const client = clientForText();
  let stopped = false, finish;
  client.options.micStream = { getTracks: () => [{ stop() {stopped = true;} }] };
  client._ctx = { close: () => new Promise(resolve => {finish = resolve;}) };
  const closing = client.close();
  assert.equal(stopped, true);
  assert.equal(client.options.micStream, null);
  finish();
  await closing;
});

test('text-only connect never asks for microphone permission', async () => {
  let acquired = false;
  const client = new S2sWsRealtimeClient({ directUrl: 'ws://localhost/v1/realtime', textOnly: true,
    acquireMic: async () => { acquired = true; throw new Error('unexpected microphone'); } });
  client._setupAudio = async () => {};
  client._openWebSocket = async () => {
    message(client, { type: 'session.created' });
    message(client, { type: 'session.updated' });
  };
  await client.connect();
  assert.equal(acquired, false);
  assert.equal(client._sessionConfigured, true);
});

test('continuous text sends ignore the first acknowledgement and stale audio', () => {
  const client = clientForText();
  const heard = [];
  client._queueAudioDelta = (audio, response) => heard.push([audio, response]);
  client.sendText('first');
  client.sendText('second');
  message(client, { type: 'user.text.accepted', generation: 1, request_id: 1 });
  message(client, { type: 'response.output_audio.delta', generation: 1, delta: 'old', response_id: 'old' });
  assert.deepEqual(heard, []);
  message(client, { type: 'user.text.accepted', generation: 2, request_id: 2 });
  message(client, { type: 'response.output_audio.delta', generation: 1, delta: 'late', response_id: 'old' });
  message(client, { type: 'response.output_audio.delta', generation: 2, delta: 'new', response_id: 'new' });
  assert.deepEqual(heard, [['new', 'new']]);
});

test('cancel clears playback immediately and rejects obsolete completion', () => {
  const client = clientForText();
  const commands = [];
  client._playbackNode = { port: { postMessage: command => commands.push(command.kind) } };
  let finished = 0;
  client.addEventListener('response-finished', () => finished++);
  client.cancelResponse();
  assert.deepEqual(commands, ['clear']);
  message(client, { type: 'response.cancelled', generation: 3, request_id: 1 });
  message(client, { type: 'response.done', generation: 2, response: { id: 'old', status: 'completed' } });
  assert.equal(finished, 0);
  assert.equal(client._status, 'connected');
});

test('audio chunk notification arrives before sentence buffering and ignores stale generations', () => {
  const client = clientForText();
  client._playbackNode = { port: { postMessage() {} } };
  const chunks = [];
  client.addEventListener('audio-chunk', event => chunks.push(event.detail.responseId));
  const delta = Buffer.alloc(8).toString('base64');
  client.sendText('question');
  message(client, { type: 'user.text.accepted', generation: 2, request_id: 1 });
  message(client, { type: 'response.output_audio.delta', generation: 1, delta, response_id: 'stale' });
  message(client, { type: 'response.output_audio.delta', generation: 2, delta: '', response_id: 'empty' });
  assert.deepEqual(chunks, []);
  message(client, { type: 'response.output_audio.delta', generation: 2, delta, response_id: 'current' });
  assert.deepEqual(chunks, ['current']);
  assert.equal(client._bufferedPlayback.length, 1, 'notification does not wait for playback or a complete sentence');
});

test('late microphone permission after ending session releases its track', async () => {
  const client = clientForText();
  let stopped = false;
  client._acquireMic = async () => {
    client._closed = true;
    return { getTracks: () => [{ stop: () => { stopped = true; } }] };
  };
  await assert.rejects(client.enableMicrophone(), /aborted/);
  assert.equal(stopped, true);
});

test('text interruption marks a partial reply and clears its retained buffers', () => {
  const client = clientForText();
  client._asstFullByResp.set('previous', 'partial answer');
  const finished = [];
  client.addEventListener('response-finished', event => finished.push(event.detail));
  client.sendText('next question');
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, 'cancelled');
  assert.equal(finished[0].transcript, 'partial answer');
  assert.equal(client._asstFullByResp.size, 0);
  assert.equal(client._asstTranscriptByResp.size, 0);
});
