/* Prepare real-browser manifests from the existing API replay. GET requests only. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const directory=path.resolve('build/functional-qa-20261008');
const source=path.join(directory,'remaining-replay.json'),replay=JSON.parse(fs.readFileSync(source,'utf8'));
const liveControls=JSON.parse(fs.readFileSync(path.join(directory,'live-controls.json'),'utf8'));
const base=process.env.WORKBENCH_URL||'http://127.0.0.1:7860';
const ids=[
  'asr-qwen06-details-fixed','asr-qwen06-stream-vad','asr-new-moonshine-offline',
  'music-ace-text-instrumental','music-ace-text-lyrics','music-ace-source-analysis','music-new-midashenglm',
  'design-qwen17-en','design-qwen17-zh-greedy','design-new-fireredtts3',
  'vc-seed-v2','vc-seed-svc-pitch','vc-rvc-chocola-pitch','vc-new-tone-color',
  'process-builtin-rnnoise','process-builtin-deepfilternet2','process-builtin-zipenhancer','process-builtin-gtcrn-streaming','process-builtin-gtcrn-dns3','process-builtin-gtcrn-vctk','process-builtin-flashsr',
  'sep-mel-roformer','sep-new-htdemucs6','vad-silero-vad','vad-marblenet-vad','vad-new-pulsevad',
  'diar-sortformer','diar-new-nemotron3','turn-new-smartturn','align-qwen-en','align-qwen-zh','align-new-crisper','score-new-sheetsage2',
];
function uiRoute(detail){return ['tts','asr','music','design','vc'].includes(detail.task)?detail.task:`tools/${detail.task==='analysis'?detail.model_task:detail.task}`;}
function exposedInputs(model,detail){
  const previous=liveControls.models.find(row=>row.id===model),keys=new Set((previous?.controls||[]).filter(row=>row.id?.startsWith('input-')||row.key&&!row.id).map(row=>row.key));
  for(const row of previous?.expertControls||[])if(row.id?.startsWith('input-'))keys.add(row.id.replace(/^input-[^-]+-/,''));
  if(detail.task==='asr'){
    if(detail.asr_inputs?.context)keys.add('context');if(detail.asr_inputs?.details)keys.add('detailed');if(detail.asr_inputs?.dialogue)keys.add('dialogue');
    if(detail.streaming)keys.add('stream');if(detail.languages?.length>1)keys.add('language');
  }
  if(detail.task==='music'){
    keys.add('text');keys.add('seed');if(detail.music_inputs?.lyrics)keys.add('lyrics');if(detail.music_inputs?.duration)keys.add('duration');
  }
  if(detail.task==='design'){for(const key of ['text','instruct','seed','max_tokens'])keys.add(key);}
  if(detail.task==='vc'&&detail.profile?.send_seed!==false)keys.add('seed');
  if(detail.model_task==='align'){keys.add('transcript');keys.add('language');}
  return keys;
}
async function main(){
  const models=[...new Set(['pocket-tts',...ids.map(id=>replay.cases.find(row=>row.id===id)?.model)])];if(models.includes(undefined))throw Error('A source case id is missing.');
  const details=Object.fromEntries(await Promise.all(models.map(async model=>{const response=await fetch(`${base}/api/workbench/models/${encodeURIComponent(model)}`);if(!response.ok)throw Error(`${model}: ${response.status}`);return [model,await response.json()];})));
  const cases=ids.map(id=>{
    const original=replay.cases.find(row=>row.id===id),detail=details[original.model],inputs={},options={...original.options},adaptations=[];
    const exposed=exposedInputs(original.model,detail),parameterNames=new Set(detail.parameters.map(row=>row.name));
    for(const [key,value]of Object.entries(original.inputs||{})){
      if(exposed.has(key))inputs[key]=value;
      else if(parameterNames.has(key)){options[key]=value;adaptations.push(`Moved input ${key} to model option; no input widget is exposed.`);}
      else if(value!==false&&value!==''){adaptations.push(`Omitted input ${key}; this model exposes no matching input or backend option.`);}
      else adaptations.push(`Omitted empty/false input ${key}; this model does not expose it.`);
    }
    for(const [key,file]of Object.entries(original.uploads||{})){const absolute=path.resolve(file);if(!fs.existsSync(absolute))throw Error(`${id}: missing fixture ${absolute}`);inputs[key]=absolute;}
    if(Object.hasOwn(inputs,'seed')&&Object.hasOwn(options,'seed')){delete options.seed;adaptations.push('Seed uses the dedicated input; removed duplicate option.');}
    if(id==='music-ace-source-analysis'){options.task_route='cover';adaptations.push('Selected cover to expose the actual source-audio upload and analysis button.');}
    const assertions={min_artifacts:original.min_artifacts,...Object.fromEntries(Object.entries(original.supplemental_assertions||{}).filter(([key])=>['nonempty_text','minimum_audio_artifacts','artifact_suffixes','parameter_updates_nonempty'].includes(key)))};
    const menu=uiRoute(detail),modelInputs=Object.fromEntries(Object.entries(inputs).filter(([key])=>!['audio','voice','rvc_voice_model','rvc_retrieval_index'].includes(key)));
    return {id:`browser-${id}`,source_case:id,status:'prepared_not_executed',menu,task:original.task,model:original.model,new_model:original.new_model,
      ready:detail.installed,requires:detail.installed?null:original.requires||{download_before_case:true,target_path:detail.install_path,package_id:detail.download_id},
      inputs,options,action:original.action,timeout_ms:(original.timeout||900)*1000,play_audio:!!original.supplemental_assertions?.audio_artifact||!!original.supplemental_assertions?.minimum_audio_artifacts,
      download:original.action!=='analyze_source',persist_route:true,text_actions:!!original.supplemental_assertions?.nonempty_text,assertions,
      input_contract:{observed_input_keys:[...exposed],requested_input_keys:Object.keys(modelInputs),options_with_actual_controls:Object.keys(options).filter(key=>parameterNames.has(key)),options_using_advanced_json:Object.keys(options).filter(key=>!parameterNames.has(key)),adaptations},
      coverage:['actual browser model selection without load','explicit model load','Generate or analysis button','actual submitted inputs/options','terminal UI state',...(original.coverage||[]),'artifact downloads and result persistence'],
      quality_note:original.quality_note||null};
  });
  const stop=JSON.parse(JSON.stringify(cases.find(row=>row.source_case==='music-ace-text-instrumental')));Object.assign(stop,{id:'browser-music-ace-stop',source_case:null,cancel_after_ms:0,play_audio:false,download:false,persist_route:false,text_actions:false,assertions:{},coverage:['actual Stop click','immediate cancelling acknowledgement','terminal cancelled state']});
  cases.splice(cases.findIndex(row=>row.source_case==='music-new-midashenglm'),0,stop);
  const pocket=details['pocket-tts'];
  const pocketFull={id:'browser-tts-pocket-full',source_case:null,status:'prepared_not_executed',menu:'tts',task:'tts',model:'pocket-tts',new_model:false,
    ready:pocket.installed,requires:pocket.installed?null:{download_before_case:true,target_path:pocket.install_path,package_id:pocket.download_id},
    inputs:{builtin_voice:'demo_01_man.wav',text:'Hello. This short test checks the complete browser voice synthesis workflow. The selected library voice should be used, and the generated audio should remain available after changing menus.',stream:false,seed:42},options:{},
    timeout_ms:300000,play_audio:true,download:true,persist_route:true,text_actions:false,assertions:{min_artifacts:1,minimum_audio_artifacts:1},
    coverage:['actual browser selection without loading','demo_01_man library reference','explicit model load enables Generate','actual synthesis POST inputs','native audio metadata and playback','result download','result persistence after menu switch']};
  const paragraph='The quiet library opened just after sunrise, and a small group of readers settled beside the windows. Outside, a delivery bicycle crossed the square while the baker arranged fresh bread in a wooden tray. Everyone had a different plan for the morning, but they shared the same unhurried rhythm. A traveler unfolded a paper map, marked a path along the river, and asked which bridge offered the clearest view of the distant hills. The librarian smiled and explained the route with patient, simple directions. ';
  const cancellationText=paragraph.repeat(5).trim();
  if(cancellationText.length<1500||cancellationText.length>3000)throw Error('Pocket cancellation text must be 1500 to 3000 English characters.');
  const pocketStop=JSON.parse(JSON.stringify(pocketFull));Object.assign(pocketStop,{id:'browser-tts-pocket-synthesis-stop',cancel_after_ms:700,cancel_stage_pattern:'声音合成中|Synthesizing audio',play_audio:false,download:false,persist_route:false,assertions:{},
    inputs:{...pocketFull.inputs,text:cancellationText},
    coverage:['explicit Pocket load completes before submission','long English synthesis input','wait for real synthesis stage and then 700 ms','actual Stop click during synthesis','immediate 正在停止任务 acknowledgement','duplicate Stop disabled while cancelling','terminal 任务已停止 or valid instant cancellation']});
  cases.unshift(pocketFull,pocketStop);
  const output={generated_at:new Date().toISOString(),status:'prepared_not_executed',base,source,source_sha256:crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
    runner:path.resolve('tools/qa/workbench_live_execute.cjs'),invocation:'node tools/qa/workbench_live_execute.cjs --case build/functional-qa-20261008/browser-menu-cases.json --case-id <id>',
    scheduling:'Root executes one case at a time after its active API/GPU inference is idle. Pending models require coordinated installation first. This preparation runs GET only.',
    fixtures:replay.fixtures,menu_order:['tts','asr','music','design','vc','references (management UI report)','tools/processing','tools/separation','tools/vad','tools/diar','tools/turn','tools/align','tools/midi','models (management UI report)','settings (management UI report)'],
    management_evidence:{first_run:path.join(directory,'ui-management/management.json'),first_run_failed_assertion:'Strict API clipboard equality: Windows normalized LF to CRLF; all preceding CRUD/download checks passed.',diagnostic:path.join(directory,'ui-management-settings-retest/management-clipboard-crlf.json'),corrected_retest:path.join(directory,'ui-management-settings-retest/management.json'),correction:'Comparison now normalizes CRLF to LF. Settings retest passed all 21 checks. No product change or mocked result.',cleanup:'QA reference and upload removed; original user WAV hashes and prompt_text raw SHA256 exactly preserved/restored.'},
    summary:{cases:cases.length,ready:cases.filter(row=>row.ready).length,pending:cases.filter(row=>!row.ready).length,menus:[...new Set(cases.map(row=>row.menu))]},cases};
  fs.writeFileSync(path.join(directory,'browser-menu-cases.json'),JSON.stringify(output,null,2));
  fs.writeFileSync(path.join(directory,'browser-menu-model-details.json'),JSON.stringify(details,null,2));console.log(JSON.stringify(output.summary));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
