import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const VISEMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'ih', 'oh', 'ou'];
const normalize = name => String(name).replace(/[^a-z0-9]/gi, '').toLowerCase();
const aliases = { ih: ['ih', 'I'], oh: ['oh', 'O'], ou: ['ou', 'U'] };

function visemeKey(key) {
  const name = Number.isInteger(key) ? VISEMES[key] : String(key).replace(/^viseme[_ .-]?/i, '');
  return VISEMES.find(value => [value, ...(aliases[value] || [])].some(alias => normalize(alias) === normalize(name)));
}

/** Load the actual skinned GLB. Audio analysis is supplied by the existing player. */
export async function createCharacter(container) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 20);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;background:radial-gradient(ellipse at 45% 36%,#dedad5 0%,#c6c2bc 52%,#a5a49f 100%);';
  renderer.domElement.setAttribute('aria-label', '写实人物口型预览');
  container.append(renderer.domElement);
  const gl = renderer.getContext();
  const gpuInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = gl.getParameter(gpuInfo ? gpuInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER);

  scene.add(new THREE.HemisphereLight(0xf3f0ea, 0x555b60, 0.65));
  for (const [color, intensity, x, y, z] of [
    [0xffead8, 2.8, -3, 4, 3],
    [0xe5eeff, 0.65, 3, 2.6, 4],
    [0xfff5e8, 2.1, 0.5, 3, -3],
  ]) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(x, y, z);
    scene.add(light);
  }

  let model;
  try {
    model = (await new GLTFLoader().loadAsync(new URL('./assets/mpfb.glb', import.meta.url).href)).scene;
  } catch (error) {
    renderer.dispose();
    renderer.domElement.remove();
    throw error;
  }
  scene.add(model);
  // Small studio reflection map supplies broad catchlights without real-time shadows.
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(0.12, 0.13, 0.15);
  for (const [intensity, x, y, z, width, height] of [[6, -3, 3, 4, 3, 4], [1.5, 3, 2, 4, 2, 3]]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({color: new THREE.Color(intensity, intensity, intensity), side: THREE.DoubleSide}));
    panel.position.set(x, y, z);
    panel.lookAt(0, 0, 0);
    studio.add(panel);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(studio, 0.06);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.35;
  pmrem.dispose();
  studio.children.forEach(panel => {panel.geometry.dispose(); panel.material.dispose();});
  model.updateMatrixWorld(true);
  let bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  model.scale.multiplyScalar(2 / size.y);
  model.updateMatrixWorld(true);
  bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.y -= bounds.min.y;
  model.position.z -= center.z;
  model.updateMatrixWorld(true);

  const bones = [];
  const meshes = [];
  const mouths = new Map(VISEMES.map(key => [key, []]));
  const blinks = [];
  const targets = Object.fromEntries(VISEMES.map(key => [key, 0]));
  model.traverse(object => {
    if (object.isBone) bones.push(object);
    if (!object.isMesh) return;
    meshes.push(object);
    object.frustumCulled = false;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material?.name === 'Human.high-poly') material.roughness = 0.18;
      for (const value of Object.values(material || {})) {
        if (value?.isTexture) value.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      }
    }
    for (const [name, index] of Object.entries(object.morphTargetDictionary || {})) {
      const shortName = name.replace(/^.*(?:viseme[_ .-])/i, '');
      const key = visemeKey(shortName);
      const entry = { mesh: object, index, initial: object.morphTargetInfluences[index] || 0 };
      if (key) mouths.get(key).push(entry);
      if (/eyeblink|blinkleft|blinkright/i.test(normalize(name))) blinks.push(entry);
    }
  });

  const findBone = expressions => bones.find(bone => expressions.some(pattern => pattern.test(normalize(bone.name))));
  const head = findBone([/^head$/, /headbone$/, /mixamorighead$/]);
  const chest = findBone([/^chest$/, /spine0?3$/, /spine0?2$/, /upperchest$/]);

  // Use each bone's actual child direction, rather than assuming its local axes.
  function lowerArm(upper, lower, side) {
    if (!upper || !lower) return;
    model.updateMatrixWorld(true);
    const source = lower.getWorldPosition(new THREE.Vector3()).sub(upper.getWorldPosition(new THREE.Vector3())).normalize();
    const destination = new THREE.Vector3(side * 0.16, -1, 0.08).normalize();
    const rotation = new THREE.Quaternion().setFromUnitVectors(source, destination);
    const world = upper.getWorldQuaternion(new THREE.Quaternion());
    const parent = upper.parent.getWorldQuaternion(new THREE.Quaternion());
    upper.quaternion.copy(parent.invert().multiply(rotation.multiply(world)));
  }
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    const prefix = side === 'left' ? 'l' : 'r';
    const upper = findBone([new RegExp(`^${side}arm$`), new RegExp(`^${side}upperarm$`), new RegExp(`^upperarm${prefix}$`), new RegExp(`^upperarm${side}$`), new RegExp(`^mixamorig${side}arm$`)]);
    const lower = findBone([new RegExp(`^${side}forearm$`), new RegExp(`^${side}lowerarm$`), new RegExp(`^forearm${prefix}$`), new RegExp(`^lowerarm${prefix}$`), new RegExp(`^mixamorig${side}forearm$`)]);
    lowerArm(upper, lower, sign);
  }
  model.updateMatrixWorld(true);

  const initialHead = head?.quaternion.clone();
  const initialChest = chest?.scale.clone();
  const initialPosition = model.position.y;
  const headDelta = new THREE.Quaternion();
  const headEuler = new THREE.Euler();
  const breathingScale = new THREE.Vector3();
  let motionEnabled = true;
  let speaking = false;
  let disposed = false;
  let frameId = 0;
  let lastFrame = 0;
  let nextFrame = 0;
  let elapsed = 0;
  let nextBlink = 2.5;
  let blinkStart = -1;
  let blinkCount = 0;
  let fps = 0;
  let renderedFrames = 0;
  let fpsStart = performance.now();
  let hasSize = false;

  const missing = VISEMES.filter(key => !mouths.get(key).length);
  const target = new THREE.Vector3(0, 1.64, 0);
  function resize() {
    if (disposed) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    hasSize = width > 0 && height > 0;
    if (!hasSize) {
      cancelAnimationFrame(frameId);
      frameId = 0;
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(2000000 / (width * height))));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const distance = Math.max(1.02 / (2 * tangent), 0.8 / (2 * tangent * camera.aspect));
    camera.position.set(0, 1.82, distance);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    resume();
  }

  function resetMouth() {
    if (disposed) return;
    for (const key of VISEMES) {
      targets[key] = 0;
      for (const entry of mouths.get(key)) entry.mesh.morphTargetInfluences[entry.index] = entry.initial;
    }
  }

  function frame(now) {
    frameId = 0;
    if (disposed || document.hidden || !hasSize) return;
    frameId = requestAnimationFrame(frame);
    if (now < nextFrame) return;
    if (!nextFrame || now - nextFrame > 100) nextFrame = now;
    nextFrame += 1000 / 30;
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 1 / 30;
    lastFrame = now;
    elapsed += dt;
    const smoothing = 1 - Math.exp(-dt * 24);
    for (const key of VISEMES) {
      for (const entry of mouths.get(key)) {
        const influences = entry.mesh.morphTargetInfluences;
        const desired = entry.initial + targets[key] * (1 - entry.initial);
        influences[entry.index] += (desired - influences[entry.index]) * smoothing;
      }
    }
    if (motionEnabled) {
      if (elapsed >= nextBlink && blinkStart < 0) {
        blinkStart = elapsed;
        blinkCount++;
      }
      let blink = 0;
      if (blinkStart >= 0) {
        const progress = (elapsed - blinkStart) / 0.16;
        if (progress >= 1) {
          blinkStart = -1;
          nextBlink = elapsed + 2.6 + Math.random() * 3.2;
        } else blink = Math.sin(Math.PI * progress);
      }
      for (const entry of blinks) entry.mesh.morphTargetInfluences[entry.index] = entry.initial + blink * (1 - entry.initial);
      if (head) {
        headEuler.set(
          0.012 * Math.sin(elapsed * 0.79) + (speaking ? 0.015 * Math.sin(elapsed * 2.1) : 0),
          0.024 * Math.sin(elapsed * 0.47),
          0.009 * Math.sin(elapsed * 0.61),
        );
        headDelta.setFromEuler(headEuler);
        head.quaternion.copy(initialHead).multiply(headDelta);
      }
      const breath = Math.sin(elapsed * 1.3);
      model.position.y = initialPosition + breath * 0.002;
      if (chest) chest.scale.copy(initialChest).multiply(breathingScale.set(1, 1 + breath * 0.002, 1 + breath * 0.001));
    }
    renderer.render(scene, camera);
    renderedFrames++;
    if (now - fpsStart >= 1000) {
      fps = renderedFrames * 1000 / (now - fpsStart);
      renderedFrames = 0;
      fpsStart = now;
    }
  }

  function resume() {
    if (!disposed && !document.hidden && hasSize && !frameId) {
      lastFrame = 0;
      nextFrame = 0;
      fpsStart = performance.now();
      renderedFrames = 0;
      frameId = requestAnimationFrame(frame);
    }
  }
  function visibilityChanged() {
    if (document.hidden) {
      cancelAnimationFrame(frameId);
      frameId = 0;
    } else resume();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  document.addEventListener('visibilitychange', visibilityChanged);
  resize();

  return {
    setViseme(key, value) {
      const canonical = visemeKey(key);
      if (canonical && !disposed) targets[canonical] = THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
    },
    setSpeaking(value) { speaking = Boolean(value); },
    setMotionEnabled(value) {
      if (disposed) return;
      motionEnabled = Boolean(value);
      if (!motionEnabled) {
        if (head) head.quaternion.copy(initialHead);
        if (chest) chest.scale.copy(initialChest);
        model.position.y = initialPosition;
        for (const entry of blinks) entry.mesh.morphTargetInfluences[entry.index] = entry.initial;
        blinkStart = -1;
      }
    },
    resetMouth,
    stats() {
      if (disposed) return { disposed: true };
      return {
        fps: Math.round(fps),
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        visemes: VISEMES.filter(key => mouths.get(key).length),
        missingVisemes: missing,
        mouthMax: Math.max(0, ...VISEMES.filter(key => key !== 'sil').flatMap(key => mouths.get(key).map(entry => entry.mesh.morphTargetInfluences[entry.index] - entry.initial))),
        headMovement: head ? head.quaternion.angleTo(initialHead) : 0,
        blinks: blinkCount,
        textureCount: renderer.info.memory.textures,
        gpu,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frameId);
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibilityChanged);
      const textures = new Set();
      const geometries = new Set();
      const materials = new Set();
      const skeletons = new Set();
      for (const mesh of meshes) {
        geometries.add(mesh.geometry);
        if (mesh.skeleton) skeletons.add(mesh.skeleton);
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          materials.add(material);
          for (const value of Object.values(material || {})) if (value?.isTexture) textures.add(value);
        }
      }
      textures.forEach(texture => { texture.dispose(); texture.image?.close?.(); });
      geometries.forEach(geometry => geometry.dispose());
      materials.forEach(material => material?.dispose());
      skeletons.forEach(skeleton => skeleton.dispose());
      environment.dispose();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      mouths.clear();
      meshes.length = 0;
      bones.length = 0;
      blinks.length = 0;
      model = null;
    },
  };
}
