// Model-free browser checks of the exact requests emitted by the native UI.
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(process.env.UI_BROWSER_TOOLS
  ? path.resolve(process.env.UI_BROWSER_TOOLS, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const wav = Buffer.alloc(44 + 4800 * 4);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28);
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const configured = [
  ['review-irodori-mf', 'irodori_tts', 'tts'],
  ['review-magenta', 'magenta_realtime_2', 'gen'],
  ['review-phonon', 'gradium_phonon', 'tts']
].map(([id, family, task]) => ({ id, family, task, mode: 'offline', configured: true, loaded: true,
  path: `/fixture/${id}.gguf`, load_options: {}, session_options: {} }));
const speech = [], tasks = [];
const browser = await chromium.launch({ channel: process.env.UI_BROWSER_CHANNEL || 'chrome', headless: true });
try {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/health', route => route.fulfill({ json: {
    status: 'ok', backend: 'fixture', models: configured.length, ui: true, ui_management: false
  } }));
  await page.route('**/v1/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const body = request.method() === 'POST' && request.headers()['content-type']?.includes('application/json')
      ? request.postDataJSON() : {};
    let json = { data: [], voices: [] };
    if (url.pathname === '/v1/models') json = { data: configured };
    if (url.pathname === '/v1/ui/path-status') json = { exists: true, file: true, directory: false };
    if (url.pathname === '/v1/audio/speech') {
      speech.push(body);
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
    }
    if (url.pathname === '/v1/tasks/run') {
      tasks.push(body);
      json = { audio: wav.toString('base64'), sample_rate: 48000, channels: 2 };
    }
    return route.fulfill({ json });
  });
  await page.goto(process.env.UI_BASE_URL || 'http://127.0.0.1:8080');
  await page.locator('#model option[value="review-irodori-mf"]').waitFor({ state: 'attached' });
  await page.locator('#model').selectOption('review-irodori-mf');
  await page.locator('#text').fill('こんにちは。');
  await page.locator('button.run').click();
  await page.waitForFunction(() => document.querySelector('.runbar .status')?.textContent.includes('Complete in'));
  assert.equal(speech.at(-1).options.num_inference_steps, undefined,
    'An untouched control must let the checkpoint choose its RF or MeanFlow step default');
  console.log('PASS native Irodori leaves the sampler default to the checkpoint');

  await page.locator('.workflow-tabs').getByRole('button', { name: /Music/i }).click();
  await page.locator('#model').selectOption('review-magenta');
  await page.locator('#text').fill('warm electric piano');
  await page.locator('#duration').fill('7');
  await page.locator('button.run').click();
  await page.waitForFunction(() => document.querySelector('.runbar .status')?.textContent.includes('Complete in'));
  assert.equal(tasks.at(-1).request.options.duration_sec, 7);
  assert.equal(tasks.at(-1).request.duration_seconds, undefined);
  assert.equal(tasks.at(-1).request.max_tokens, undefined);
  console.log('PASS native Magenta sends its supported duration option and no token limit');

  await page.locator('.workflow-tabs').getByRole('button', { name: /^Text to speech/ }).click();
  await page.locator('#model').selectOption('review-phonon');
  await page.locator('#text').fill('This uses the bundled voice.');
  assert.equal(await page.locator('.controls input[type="file"]').evaluateAll(inputs =>
    inputs.filter(input => /audio|\.wav/.test(input.accept)).length), 0,
    'Phonon must not offer reference-recording cloning');
  await page.locator('button.run').click();
  await page.waitForFunction(() => document.querySelector('.runbar .status')?.textContent.includes('Complete in'));
  assert.equal(speech.at(-1).voice_ref, undefined);
  assert.equal(speech.at(-1).max_tokens, undefined);
  assert.deepEqual(errors, []);
  console.log('PASS native Phonon uses the bundled voice without unsupported cloning controls');
} finally {
  await browser.close();
}
