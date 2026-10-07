// A silent-by-default pixel sound toy. No microphone, network or external assets.
export function createPixelStudio() {
  const canvas=document.getElementById('pixel-canvas'),ctx=canvas.getContext('2d');
  const pause=document.getElementById('pixel-pause'),sound=document.getElementById('pixel-sound');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let active=false,paused=reduced.matches,sounding=false,audio,frame=0,last=0,time=0,beats=0,kick=0;
  const notes=[],colors=['#f2ba6b','#a4d2ae','#dba9bd','#92bfc8'];
  const rect=(x,y,w,h,color)=>{ctx.fillStyle=color;ctx.fillRect(Math.round(x),Math.round(y),w,h);};
  function note(x,y,color,flip=false){rect(x,y,6,4,color);rect(x+4,y-11,2,12,color);rect(x+6,y-11,flip?5:3,3,color);}
  function draw(){
    const t=time;ctx.clearRect(0,0,640,180);rect(0,0,640,180,'#131d22');
    for(let i=0;i<36;i++){const x=(i*97)%636,y=15+(i*41)%96;rect(x,y,1,1,i%3?'#40575b':'#72857b');}
    // An equalizer skyline and scrolling grooves become the little band's stage.
    for(let i=0;i<50;i++){const h=5+Math.round((Math.sin(t*2+i*.53)+1)*12+Math.sin(t*3+i)*4+kick*16);for(let j=0;j<h;j+=5)rect(i*13,153-j,9,3,j>24?'#49675b':'#2a4747');}
    rect(0,157,640,2,'#90a47a');rect(0,160,640,20,'#1d2a2d');
    for(let i=0;i<22;i++)rect((i*32-t*16%32+640)%640,170,16,2,'#3b514b');
    // Pixel cassette deck, bouncing tape reels and VU display.
    const bob=Math.round(Math.sin(t*4)*2-kick*3);
    rect(271,86+bob,98,68,'#0e141a');rect(266,82+bob,98,68,'#d0ab71');rect(271,87+bob,88,58,'#344548');
    rect(291,72+bob,48,4,'#d0ab71');rect(287,76+bob,4,8,'#d0ab71');rect(339,76+bob,4,8,'#d0ab71');
    for(const x of [281,333]){rect(x,104+bob,16,24,'#162127');rect(x+3,99+bob,10,34,'#162127');for(let j=0;j<4;j++)rect(x+4,106+j*6+bob,8,2,'#60746a');}
    rect(302,99+bob,26,14,'#121e22');for(let i=0;i<5;i++)rect(305+i*4,109-Math.round((Math.sin(t*5+i)+1)*3)+bob,2,3,'#b8db9d');
    rect(301,120+bob,28,14,'#c5bd93');for(const x of [307,317]){rect(x,123+bob,5,5,'#263936');rect(x+(Math.floor(t*8)%2),124+bob,2,2,'#e7d6a5');}
    // Four note creatures hop in sync, with eyes, feet and occasional music bubbles.
    [159,215,420,477].forEach((x,i)=>{const jump=Math.max(0,Math.sin(t*4+i*1.4))*13+kick*(10+i*2),y=141-jump,c=colors[i];
      rect(x-2,155,19,2,'#0d161b');rect(x,y,13,11,c);rect(x+10,y-17,3,23,c);rect(x+13,y-17,8,4,c);
      rect(x+3,y+2,2,3,'#172128');rect(x+8,y+2,2,3,'#172128');rect(x+2,y+11,3,3,c);rect(x+9,y+11,3,3,c);
      if(Math.sin(t+i)>0)note(x+4,y-30,c);
    });
    for(const n of notes){note(n.x,n.y,n.color,true);}
  }
  function tick(now){frame=0;if(!active||paused||document.hidden)return;const dt=Math.min((now-last)/1000,.05);last=now;time+=dt;kick=Math.max(0,kick-dt*2);
    for(let i=notes.length-1;i>=0;i--){const n=notes[i];n.y-=dt*43;n.x+=Math.sin(time*3+n.y)*dt*12;if(n.y<0)notes.splice(i,1);}draw();frame=requestAnimationFrame(tick);}
  function sync(){cancelAnimationFrame(frame);frame=0;pause.textContent=paused?'播放动画':'暂停动画';pause.setAttribute('aria-pressed',String(paused));if(active&&!paused&&!document.hidden){last=performance.now();frame=requestAnimationFrame(tick);}else draw();if(!active||document.hidden)audio?.suspend();else if(sounding)audio?.resume().catch(()=>{});}
  function beat(event){beats++;kick=1;document.getElementById('pixel-beats').textContent=`BEAT ${String(beats).padStart(3,'0')}`;
    const bounds=canvas.getBoundingClientRect(),x=event?.clientX?(event.clientX-bounds.left)/bounds.width*640:320;
    notes.push({x:Math.max(10,Math.min(620,x)),y:130,color:colors[beats%4]});if(notes.length>32)notes.shift();draw();
    if(sounding&&audio){const oscillator=audio.createOscillator(),gain=audio.createGain();oscillator.type='square';oscillator.frequency.value=[261.63,329.63,392,523.25,440,392,329.63,293.66][(beats-1)%8];gain.gain.setValueAtTime(.035,audio.currentTime);gain.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.16);oscillator.connect(gain);gain.connect(audio.destination);oscillator.start();oscillator.stop(audio.currentTime+.17);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};}
  }
  canvas.addEventListener('click',beat);canvas.addEventListener('keydown',e=>{if([' ','Enter'].includes(e.key)){e.preventDefault();if(!e.repeat)beat();}});
  pause.addEventListener('click',()=>{paused=!paused;sync();});
  sound.addEventListener('click',async()=>{try{if(!audio)audio=new AudioContext();sounding=!sounding;if(sounding)await audio.resume();else await audio.suspend();sound.textContent=`声音：${sounding?'开':'关'}`;sound.setAttribute('aria-pressed',String(sounding));}catch{sound.textContent='声音不可用';sounding=false;}});
  document.addEventListener('visibilitychange',sync);reduced.addEventListener('change',()=>{paused=reduced.matches;sync();});
  window.addEventListener('pagehide',()=>{active=false;sync();audio?.close();});draw();
  return {setActive(value){active=value;sync();}};
}
