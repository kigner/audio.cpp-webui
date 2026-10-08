// Original illustration + generated eye/lip deltas; no replacement 3D head.
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
uniform sampler2D sceneTexture, faceTexture;
uniform vec4 crop;
uniform vec3 faceMap[9];
uniform float mouth[5], blink, listening, breath, headAngle;
uniform vec2 headOffset, shoulderLift;
vec2 rotate(vec2 p,float a){float c=cos(a),s=sin(a);return mat2(c,s,-s,c)*p;}
float region(vec2 p,vec2 center,vec2 radius){return 1.-smoothstep(.5,1.,length((p-center)/radius));}
float featherMask(vec2 p,vec2 center,vec2 radius){float r=length(rotate(p-center,.24)/radius);return 1.-smoothstep(.70,1.,r);}
vec3 face(vec2 p,int cell){vec3 m=faceMap[cell];vec2 local=(p-m.xy)/m.z;vec2 grid=vec2(float(cell%3),float(cell/3));return texture(faceTexture,(clamp(local,vec2(1.),vec2(417.))+grid*418.)/1254.).rgb;}
void main(){
  vec2 p=crop.xy+uv*crop.zw;
  // All face samples use the same deformed coordinates as the illustration.
  // Compact masks confine movement to the character instead of warping the room.
  float headMask=region(p,vec2(610.,230.),vec2(255.,330.));
  float leftShoulder=region(p,vec2(427.,470.),vec2(126.,245.))*smoothstep(310.,355.,p.y);
  float rightShoulder=region(p,vec2(929.,456.),vec2(126.,230.))*smoothstep(310.,355.,p.y);
  float chest=region(p,vec2(742.,563.),vec2(255.,230.));
  vec2 pivot=vec2(620.,380.);
  p+=(rotate(p-pivot,-headAngle)-(p-pivot)-headOffset)*headMask;
  p.y+=shoulderLift.x*leftShoulder+shoulderLift.y*rightShoulder+breath*chest;
  p.x+=.12*(shoulderLift.x*leftShoulder-shoulderLift.y*rightShoulder);
  vec3 base=texture(sceneTexture,p/vec2(1672.,941.)).rgb;
  vec3 m=faceMap[0];vec2 local=(p-m.xy)/m.z;
  float eyes=max(featherMask(local,vec2(127.,155.),vec2(69.,37.)),featherMask(local,vec2(312.,88.),vec2(67.,38.)));
  float lips=featherMask(local,vec2(265.,286.),vec2(110.,70.));
  if(eyes>.001&&blink>.001){
    vec3 neutral=base;
    float closure=blink;
    vec3 closed=closure<.5?mix(neutral,face(p,2),closure*2.):mix(face(p,2),face(p,1),(closure-.5)*2.);
    base=mix(base,closed,eyes);
  }
  if(lips>.001){
    int selected=0;float strength=0.;
    for(int i=0;i<5;i++){if(mouth[i]>strength){selected=i;strength=mouth[i];}}
    if(strength>.15)base=mix(base,face(p,selected+3),lips);
    else base=mix(base,face(p,8),listening*.45*lips);
  }
  color=vec4(clamp(base,0.,1.),1.);
}`;

async function loadImage(name) {
  const image = new Image(); image.decoding = 'async';
  image.src = new URL(`./assets/${name}`, import.meta.url).href;
  await image.decode(); return image;
}
function compile(gl, type, source) {
  const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
  if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) {const error=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(error);}
  return shader;
}
export async function createCharacter(container) {
  const [scene,atlas,registration] = await Promise.all([
    loadImage('scene.png'),loadImage('face-atlas.png'),
    fetch(new URL('./assets/face-registration.json',import.meta.url)).then(r=>{if(!r.ok)throw new Error('表情素材无法读取。');return r.json();})
  ]);
  const canvas=document.createElement('canvas');canvas.setAttribute('aria-label','暖灯卧室中的虚拟恋人');
  canvas.style.cssText='display:block;width:100%;height:100%;object-fit:cover';
  const gl=canvas.getContext('webgl2',{alpha:false,antialias:false,powerPreference:'low-power',preserveDrawingBuffer:true});
  if(!gl)throw new Error('浏览器没有可用的 WebGL2 渲染器。');
  const shaders=[compile(gl,gl.VERTEX_SHADER,VERTEX),compile(gl,gl.FRAGMENT_SHADER,FRAGMENT)];
  const program=gl.createProgram();shaders.forEach(s=>gl.attachShader(program,s));gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);shaders.forEach(s=>gl.deleteShader(s));
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
  const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  const textures=[scene,atlas].map((image,index)=>{
    const texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0+index);gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);return texture;
  });
  const location=Object.fromEntries(['crop','mouth','blink','listening','breath','headAngle','headOffset','shoulderLift'].map(key=>[key,gl.getUniformLocation(program,key)]));
  gl.uniform1i(gl.getUniformLocation(program,'sceneTexture'),0);gl.uniform1i(gl.getUniformLocation(program,'faceTexture'),1);
  gl.uniform3fv(gl.getUniformLocation(program,'faceMap[0]'),new Float32Array(registration.transforms.flatMap(t=>[t.offsetX,t.offsetY,t.scale])));
  container.append(canvas);
  const gpuExtension=gl.getExtension('WEBGL_debug_renderer_info');
  const gpu=gl.getParameter(gpuExtension?gpuExtension.UNMASKED_RENDERER_WEBGL:gl.RENDERER);
  const visemes=new Map(),weights=new Float32Array(5);
  let speaking=false,listen=true,motion=true,disposed=false,visible=false;
  let animation=normalizeAnimation();
  let frameId=0,nextFrame=0,last=0,time=0,nextBlink=2.6,blinkStart=-1,blinks=0,fps=0,frames=0,fpsStart=performance.now();
  let currentBlink=0,currentBreath=0,currentAngle=0,listenAmount=0,speakingAmount=0,speechAccent=0;
  const headOffset=new Float32Array(2),shoulderLift=new Float32Array(2);
  function resize(){
    if(disposed)return;
    const width=container.clientWidth,height=container.clientHeight;visible=width>0&&height>0;
    if(!visible){cancelAnimationFrame(frameId);frameId=0;return;}
    const dpr=Math.min(devicePixelRatio||1,1.5,Math.sqrt(2000000/(width*height)));
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);gl.viewport(0,0,canvas.width,canvas.height);
    const ratio=width/height;
    const w=Math.min(1353,941*ratio),h=Math.min(941,1353/ratio);
    gl.uniform4f(location.crop,(1353-w)/2,(941-h)/2,w,h);resume();
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
    const strength=animation.strength;
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
    stats(){return disposed?{disposed:true}:{fps:Math.round(fps),gpu,visemes:Object.keys(MOUTHS),mouthMax:Math.max(...weights),blinks,blink:currentBlink,breath:currentBreath,headMovement:Math.abs(currentAngle),headOffset:Array.from(headOffset),shoulderLift:Array.from(shoulderLift),listening:listenAmount,speaking,renderer:'illustration',textures:2};},
    dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(frameId);observer.disconnect();document.removeEventListener('visibilitychange',visibility);textures.forEach(t=>gl.deleteTexture(t));gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext();canvas.remove();visemes.clear();}
  };
}
