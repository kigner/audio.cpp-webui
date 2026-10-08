// Independent transparent character layer; the room is rendered by the host.
import {normalizeAnimation} from './profile.js';
const MOUTHS = {aa:0,E:1,I:1,ih:1,SS:1,TH:1,CH:1,FF:1,DD:1,RR:1,kk:1,nn:4,O:2,oh:2,U:3,ou:3,PP:4};
const VERTEX = `#version 300 es
in vec2 position;
out vec2 uv;
void main(){gl_Position=vec4(position,0.,1.);uv=vec2(position.x*.5+.5,.5-position.y*.5);}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D characterTexture, faceTexture;
uniform vec4 crop;
uniform vec2 imageSize;
uniform vec3 referenceTransform;
uniform bool animated;
uniform vec3 faceMap[9];
uniform float tileSize, maskAngle;
uniform vec4 headRegion, leftShoulderRegion, rightShoulderRegion, chestRegion;
uniform vec4 leftEyeRegion, rightEyeRegion, mouthRegion;
uniform vec2 headPivot, shoulderGate, skinSamples[4];
uniform float mouth[5], blink, listening, breath, headAngle;
uniform vec2 headOffset, shoulderLift;
vec2 rotate(vec2 p,float a){float c=cos(a),s=sin(a);return mat2(c,s,-s,c)*p;}
float region(vec2 p,vec2 center,vec2 radius){return 1.-smoothstep(.5,1.,length((p-center)/radius));}
float featherMask(vec2 p,vec2 center,vec2 radius){float r=length(rotate(p-center,maskAngle)/radius);return 1.-smoothstep(.70,1.,r);}
vec3 face(vec2 p,int cell){vec3 m=faceMap[cell];vec2 local=(p-m.xy)/m.z;vec2 grid=vec2(float(cell%3),float(cell/3));return texture(faceTexture,(clamp(local,vec2(1.),vec2(tileSize-1.))+grid*tileSize)/(tileSize*3.)).rgb;}
vec3 mouthSkinDelta(vec2 local,int cell){
  vec2 p=faceMap[0].xy+local*faceMap[0].z;
  return texture(characterTexture,(p*referenceTransform.z+referenceTransform.xy)/imageSize).rgb-face(p,cell);
}
vec3 mouthFace(vec2 p,int cell){
  // Match surrounding skin, excluding the lips so opening the mouth cannot
  // affect the correction or leave the neutral mouth's outline behind.
  vec3 correction=(mouthSkinDelta(skinSamples[0],cell)+mouthSkinDelta(skinSamples[1],cell)
    +mouthSkinDelta(skinSamples[2],cell)+mouthSkinDelta(skinSamples[3],cell))*.25;
  return clamp(face(p,cell)+correction,0.,1.);
}
void main(){
  vec2 pixel=crop.xy+uv*crop.zw;
  vec2 p=(pixel-referenceTransform.xy)/referenceTransform.z;
  // All face samples use the same deformed coordinates as the illustration.
  // Compact masks confine movement to the character instead of warping the room.
  if(animated){
  float headMask=region(p,headRegion.xy,headRegion.zw);
  float leftShoulder=region(p,leftShoulderRegion.xy,leftShoulderRegion.zw)*smoothstep(shoulderGate.x,shoulderGate.y,p.y);
  float rightShoulder=region(p,rightShoulderRegion.xy,rightShoulderRegion.zw)*smoothstep(shoulderGate.x,shoulderGate.y,p.y);
  float chest=region(p,chestRegion.xy,chestRegion.zw);
  vec2 pivot=headPivot;
  p+=(rotate(p-pivot,-headAngle)-(p-pivot)-headOffset)*headMask;
  p.y+=shoulderLift.x*leftShoulder+shoulderLift.y*rightShoulder+breath*chest;
  p.x+=.12*(shoulderLift.x*leftShoulder-shoulderLift.y*rightShoulder);
  }
  pixel=p*referenceTransform.z+referenceTransform.xy;
  if(any(lessThan(pixel,vec2(0.)))||any(greaterThan(pixel,imageSize))){color=vec4(0.);return;}
  vec4 portrait=texture(characterTexture,pixel/imageSize);
  if(portrait.a<.001){color=vec4(0.);return;}
  vec3 base=portrait.rgb;
  if(animated){
  vec3 m=faceMap[0];vec2 local=(p-m.xy)/m.z;
  float eyes=max(featherMask(local,leftEyeRegion.xy,leftEyeRegion.zw),featherMask(local,rightEyeRegion.xy,rightEyeRegion.zw));
  float lips=featherMask(local,mouthRegion.xy,mouthRegion.zw);
  if(eyes>.001&&blink>.001){
    vec3 neutral=base;
    float closure=blink;
    vec3 closed=closure<.5?mix(neutral,face(p,2),closure*2.):mix(face(p,2),face(p,1),(closure-.5)*2.);
    base=mix(base,closed,eyes);
  }
  if(lips>.001){
    int selected=0;float strength=0.;
    for(int i=0;i<5;i++){if(mouth[i]>strength){selected=i;strength=mouth[i];}}
    if(strength>.15)base=mix(base,mouthFace(p,selected+3),lips);
    else base=mix(base,mouthFace(p,8),listening*.45*lips);
  }
  }
  color=vec4(clamp(base,0.,1.)*portrait.a,portrait.a);
}`;

async function loadImage(url) {
  const image = new Image(); image.decoding = 'async';
  image.src = url;
  await image.decode(); return image;
}
function compile(gl, type, source) {
  const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
  if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) {const error=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(error);}
  return shader;
}
export async function createCharacter(container, assetUrl = new URL('./assets/character.json', import.meta.url), {onLayout} = {}) {
  const response=await fetch(assetUrl);
  if(!response.ok)throw new Error('人物素材配置无法读取。');
  const assets=await response.json();
  const animated=Boolean(assets.faceAtlas&&assets.registration);
  const [scene,atlas,registration] = await Promise.all([
    loadImage(new URL(assets.image,assetUrl).href),
    animated?loadImage(new URL(assets.faceAtlas,assetUrl).href):null,
    animated?fetch(new URL(assets.registration,assetUrl)).then(r=>{if(!r.ok)throw new Error('表情素材无法读取。');return r.json();}):null,
  ]);
  const canvas=document.createElement('canvas');canvas.setAttribute('aria-label',assets.label||'透明人物');
  canvas.style.cssText='display:block;width:100%;height:100%';
  const gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,powerPreference:'low-power',preserveDrawingBuffer:true});
  if(!gl)throw new Error('浏览器没有可用的 WebGL2 渲染器。');
  const shaders=[compile(gl,gl.VERTEX_SHADER,VERTEX),compile(gl,gl.FRAGMENT_SHADER,FRAGMENT)];
  const program=gl.createProgram();shaders.forEach(s=>gl.attachShader(program,s));gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);shaders.forEach(s=>gl.deleteShader(s));
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
  const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  const textures=[scene,...(atlas?[atlas]:[])].map((image,index)=>{
    const texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0+index);gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);return texture;
  });
  const location=Object.fromEntries(['crop','mouth','blink','listening','breath','headAngle','headOffset','shoulderLift'].map(key=>[key,gl.getUniformLocation(program,key)]));
  gl.uniform1i(gl.getUniformLocation(program,'characterTexture'),0);gl.uniform1i(gl.getUniformLocation(program,'faceTexture'),atlas?1:0);
  gl.uniform2f(gl.getUniformLocation(program,'imageSize'),scene.width,scene.height);
  gl.uniform3fv(gl.getUniformLocation(program,'referenceTransform'),new Float32Array(assets.referenceTransform||[0,0,1]));
  gl.uniform1i(gl.getUniformLocation(program,'animated'),animated);
  if(registration)gl.uniform3fv(gl.getUniformLocation(program,'faceMap[0]'),new Float32Array(registration.transforms.flatMap(t=>[t.offsetX,t.offsetY,t.scale])));
  // Keep the original companion rig unchanged; additional portraits supply their own coordinates.
  const rig={headRegion:[610,230,255,330],leftShoulderRegion:[427,470,126,245],rightShoulderRegion:[929,456,126,230],
    chestRegion:[742,563,255,230],headPivot:[620,380],shoulderGate:[310,355],
    leftEyeRegion:[127,155,69,37],rightEyeRegion:[312,88,67,38],mouthRegion:[265,286,110,70],
    skinSamples:[[175,295],[350,250],[290,348],[300,225]],maskAngle:.24,motionScale:1,...assets.rig};
  for(const key of ['headRegion','leftShoulderRegion','rightShoulderRegion','chestRegion','leftEyeRegion','rightEyeRegion','mouthRegion'])
    gl.uniform4fv(gl.getUniformLocation(program,key),new Float32Array(rig[key]));
  for(const key of ['headPivot','shoulderGate'])gl.uniform2fv(gl.getUniformLocation(program,key),new Float32Array(rig[key]));
  gl.uniform2fv(gl.getUniformLocation(program,'skinSamples[0]'),new Float32Array(rig.skinSamples.flat()));
  gl.uniform1f(gl.getUniformLocation(program,'maskAngle'),rig.maskAngle);
  gl.uniform1f(gl.getUniformLocation(program,'tileSize'),registration?.tileSize||418);
  container.append(canvas);
  const gpuExtension=gl.getExtension('WEBGL_debug_renderer_info');
  const gpu=gl.getParameter(gpuExtension?gpuExtension.UNMASKED_RENDERER_WEBGL:gl.RENDERER);
  const visemes=new Map(),weights=new Float32Array(5);
  let speaking=false,listen=true,motion=true,disposed=false,visible=false;
  let animation=normalizeAnimation();
  let frameId=0,nextFrame=0,last=0,time=0,nextBlink=2.6,blinkStart=-1,blinks=0,fps=0,frames=0,fpsStart=performance.now();
  let currentBlink=0,currentBreath=0,currentAngle=0,listenAmount=0,speakingAmount=0,speechAccent=0;
  const headOffset=new Float32Array(2),shoulderLift=new Float32Array(2);
  let bounds;
  function resize(){
    if(disposed)return;
    const width=container.clientWidth,height=container.clientHeight;visible=width>0&&height>0;
    if(!visible){cancelAnimationFrame(frameId);frameId=0;return;}
    const dpr=Math.min(devicePixelRatio||1,1.5,Math.sqrt(2000000/(width*height)));
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);gl.viewport(0,0,canvas.width,canvas.height);
    // Fit the entire foreground without cropping. Background sizing is separate.
    const inset=width>=660?Math.min(width*.03,48):0;
    const availableWidth=width*(width>=900?.56:width>=660?.72:1)-inset;
    let scale=Math.min(availableWidth/scene.width,height/scene.height);
    let x=width-inset-scene.width*scale;
    if(assets.sceneLayout){
      // A seated character and her sofa must share one transform, including on narrow screens.
      const [left,,right]=assets.sceneLayout.subjectBounds;
      scale=Math.min(width>=900?width/scene.width:(width-16)/(right-left),height/scene.height);
      x=width>=900?width-scene.width*scale:width/2-(left+right)/2*scale;
    }
    bounds={x,y:height-scene.height*scale,width:scene.width*scale,height:scene.height*scale};
    onLayout?.(assets.sceneLayout?{...bounds}:null);
    const w=width/scale,h=height/scale;
    gl.uniform4f(location.crop,-bounds.x/scale,-bounds.y/scale,w,h);resume();
  }
  function frame(now){
    frameId=0;if(disposed||document.hidden||!visible)return;
    frameId=requestAnimationFrame(frame);if(now<nextFrame)return;
    if(!nextFrame||now-nextFrame>100)nextFrame=now;nextFrame+=1000/30;
    const dt=last?Math.min((now-last)/1000,.1):1/30;last=now;time+=dt;
    const target=new Float32Array(5);
    if(animation.mouth)for(const [key,value] of visemes){if(MOUTHS[key]!==undefined)target[MOUTHS[key]]=Math.max(target[MOUTHS[key]],value);}
    const sum=target.reduce((a,b)=>a+b,0);if(sum>1)target.forEach((v,i)=>target[i]=v/sum);
    const smooth=1-Math.exp(-dt*24);weights.forEach((v,i)=>weights[i]+=(target[i]-v)*smooth);
    listenAmount+=((animation.listening&&listen&&!speaking?1:0)-listenAmount)*(1-Math.exp(-dt*3));
    speakingAmount+=((speaking?1:0)-speakingAmount)*(1-Math.exp(-dt*4));
    speechAccent+=((speaking?Math.max(...weights):0)-speechAccent)*(1-Math.exp(-dt*6));
    currentBlink=0;
    if(motion&&animation.blink){
      if(time>=nextBlink&&blinkStart<0){blinkStart=time;blinks++;}
      if(blinkStart>=0){const phase=(time-blinkStart)/.19;if(phase>=1){blinkStart=-1;nextBlink=time+3.2+Math.random()*2.6;}else currentBlink=Math.sin(Math.PI*phase);}
    }
    const strength=animation.strength*rig.motionScale;
    currentBreath=motion&&animation.breath?Math.sin(time*1.35)*1.8*strength:0;
    currentAngle=motion&&animation.head?(Math.sin(time*.46)*.008+listenAmount*.016+speakingAmount*Math.sin(time*1.8)*.007)*strength:0;
    headOffset[0]=motion&&animation.head?(Math.sin(time*.63)*1.8+listenAmount*.8)*strength:0;
    headOffset[1]=motion&&animation.head?-currentBreath*.25+(speakingAmount*Math.sin(time*2.1)*1.8+speechAccent*1.2)*strength:0;
    shoulderLift[0]=motion&&animation.shoulders?((animation.breath?Math.sin(time*1.35)*4.2:0)+Math.sin(time*.57)*.9+speechAccent*.7)*strength:0;
    shoulderLift[1]=motion&&animation.shoulders?((animation.breath?Math.sin(time*1.35+.16)*3.6:0)+Math.sin(time*.71+.8)*.8+speechAccent*.5)*strength:0;
    gl.uniform1fv(location.mouth,weights);gl.uniform1f(location.blink,currentBlink);gl.uniform1f(location.listening,listenAmount);
    gl.uniform1f(location.breath,currentBreath);gl.uniform1f(location.headAngle,currentAngle);
    gl.uniform2fv(location.headOffset,headOffset);gl.uniform2fv(location.shoulderLift,shoulderLift);
    gl.drawArrays(gl.TRIANGLES,0,6);frames++;
    if(now-fpsStart>=1000){fps=frames*1000/(now-fpsStart);frames=0;fpsStart=now;}
  }
  function resume(){if(!disposed&&!document.hidden&&visible&&!frameId){last=0;nextFrame=0;fpsStart=performance.now();frames=0;frameId=requestAnimationFrame(frame);}}
  function visibility(){if(document.hidden){cancelAnimationFrame(frameId);frameId=0;}else resume();}
  const observer=new ResizeObserver(resize);observer.observe(container);document.addEventListener('visibilitychange',visibility);resize();
  return {
    setViseme(key,value){if(disposed)return;const name=String(key).replace(/^viseme_/,'');visemes.set(name,Math.max(0,Math.min(1,Number(value)/(name==='PP'||name==='FF'?.75:.65)||0)));},
    setSpeaking(value){speaking=Boolean(value);},
    setListening(value){listen=Boolean(value);},
    setMotionEnabled(value){motion=Boolean(value);if(!motion)blinkStart=-1;},
    setAnimationSettings(value){animation=normalizeAnimation(value);if(!animation.mouth){visemes.clear();weights.fill(0);}if(!animation.blink)blinkStart=-1;},
    resetMouth(){visemes.clear();weights.fill(0);},
    stats(){return disposed?{disposed:true}:{fps:Math.round(fps),gpu,visemes:Object.keys(MOUTHS),mouthMax:Math.max(...weights),blinks,blink:currentBlink,breath:currentBreath,headMovement:Math.abs(currentAngle),headOffset:Array.from(headOffset),shoulderLift:Array.from(shoulderLift),listening:listenAmount,speaking,renderer:'illustration',layered:true,animated,textures:textures.length,bounds:{...bounds},image:[scene.width,scene.height]};},
    dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(frameId);observer.disconnect();document.removeEventListener('visibilitychange',visibility);textures.forEach(t=>gl.deleteTexture(t));gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext();canvas.remove();visemes.clear();}
  };
}
