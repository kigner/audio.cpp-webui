import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeCharacters, loadCharacters, saveCharacters} from './realtime_static/companion/profile.js';

test('factory roles bind stable ids to the requested voice and model', () => {
  const {roles} = normalizeCharacters();
  assert.equal(Object.keys(roles).length,6);
  assert.equal(roles.companion.ttsModel,'voxcpm1');
  assert.equal(roles.companion.referenceId,'demo_02_woman');
  assert.equal(roles.baijie.ttsModel,'voxcpm1');
  assert.equal(roles.baijie.referenceId,'ref_w1');
  assert.equal(roles.baijie.referenceAudio,'voice/ref-w1.wav');
  assert.equal(roles.lily.ttsModel,'supertonic');
  assert.equal(roles.lily.ttsVoice,'F1');
  assert.equal(roles.lily.referenceAudio,'');
  assert.equal(roles.system.name,'纯净');
});

test('old factory defaults migrate without replacing custom recordings or explicit clears', () => {
  const migrated=normalizeCharacters({activeId:'lily',roles:{
    baijie:{referenceAudio:'D:\\bundle\\voice\\demo_02_woman.wav'},
    lily:{referenceAudio:'voice/demo_02_woman.wav',name:'自定义名字'},
    system:{name:'系统'},companion:{referenceAudio:'voice/custom.wav',referenceText:'原文'},
  }});
  assert.equal(migrated.roles.baijie.referenceAudio,'voice/ref-w1.wav');
  assert.equal(migrated.roles.lily.referenceAudio,'');
  assert.equal(migrated.roles.lily.name,'自定义名字');
  assert.equal(migrated.roles.companion.referenceAudio,'voice/custom.wav');
  assert.equal(migrated.roles.companion.referenceText,'原文');
  assert.equal(migrated.roles.system.name,'纯净');
  assert.equal(normalizeCharacters({roles:{baijie:{referenceAudio:''}}}).roles.baijie.referenceAudio,'');
  assert.equal(normalizeCharacters({version:2,roles:{baijie:{referenceAudio:'voice/demo_02_woman.wav'}}}).roles.baijie.referenceAudio,'voice/demo_02_woman.wav');
});

test('renaming never changes the role association across save and reload', () => {
  const values = new Map();
  const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  const state=normalizeCharacters({activeId:'baijie'});
  state.roles.baijie.name='新的名字';
  state.roles.baijie.ttsModel='custom-model';
  state.roles.baijie.referenceAudio='voice/custom.wav';
  saveCharacters(state,storage);
  const loaded=loadCharacters(storage);
  assert.equal(loaded.activeId,'baijie');
  assert.equal(loaded.roles.baijie.name,'新的名字');
  assert.equal(loaded.roles.baijie.referenceAudio,'voice/custom.wav');
  assert.equal(loaded.roles.baijie.ttsModel,'custom-model');
  values.set('audiocpp.realtime.characters','null');
  assert.equal(loadCharacters(storage).activeId,'companion');
});
