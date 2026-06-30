import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

// === UI State ===
let currentStep = 1;
let currentDepth = 1;
const cache = [];
const maxDepth = 25;

// === Geometry Math ===
function v(x, y, z) { return new THREE.Vector3(x, y, z); }

function reflectPointAcrossPlane(p, a, b, c) {
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
  const dist = new THREE.Vector3().subVectors(p, a).dot(n);
  return p.clone().addScaledVector(n, -2 * dist);
}

function pointKey(p) { return `${p.x.toFixed(8)},${p.y.toFixed(8)},${p.z.toFixed(8)}`; }
function faceKey(f) { return [pointKey(f.a), pointKey(f.b), pointKey(f.c)].sort().join("|"); }

function addOrCancelFace(map, f) {
  const k = faceKey(f);
  if (map.has(k)) map.delete(k);
  else map.set(k, f);
}

function tetraCenter(T) {
  return new THREE.Vector3().add(T[0]).add(T[1]).add(T[2]).add(T[3]).multiplyScalar(0.25);
}

function tetraBoundingRadius(T, ctr) {
  let r2 = 0;
  for (const p of T) r2 = Math.max(r2, p.distanceToSquared(ctr));
  return Math.sqrt(r2);
}

function makeTetRecord(verts, level) {
  const center = tetraCenter(verts);
  const radius = tetraBoundingRadius(verts, center);
  return { verts, level, center, radius };
}

function tetraAxes(T) {
  const faces = [[0,1,2], [0,3,1], [0,2,3], [1,3,2]];
  const axes = [];
  for (const F of faces) {
    const a = T[F[0]], b = T[F[1]], c = T[F[2]];
    const n = new THREE.Vector3().subVectors(b,a).cross(new THREE.Vector3().subVectors(c,a));
    if (n.lengthSq() > 1e-18) axes.push(n.normalize());
  }
  const edges = [[0,1], [0,2], [0,3], [1,2], [1,3], [2,3]];
  return { axes, edges };
}

function projectOntoAxis(T, axis) {
  let mn = T[0].dot(axis);
  let mx = mn;
  for (let i = 1; i < 4; i++) {
    const d = T[i].dot(axis);
    if (d < mn) mn = d;
    if (d > mx) mx = d;
  }
  return [mn, mx];
}

function strictlyOverlapsOnAxis(A, B, axis, eps) {
  const [amin, amax] = projectOntoAxis(A, axis);
  const [bmin, bmax] = projectOntoAxis(B, axis);
  return !(amax <= bmin + eps || bmax <= amin + eps);
}

function tetrahedraOverlap(Arec, Brec) {
  const A = Arec.verts, B = Brec.verts;
  const eps = 1e-7;
  const rr = Arec.radius + Brec.radius;
  if (Arec.center.distanceToSquared(Brec.center) >= rr*rr - 1e-9) return false;

  const ad = tetraAxes(A);
  const bd = tetraAxes(B);
  const axes = [...ad.axes, ...bd.axes];

  for (const ea of ad.edges) {
    const va = new THREE.Vector3().subVectors(A[ea[1]], A[ea[0]]);
    for (const eb of bd.edges) {
      const vb = new THREE.Vector3().subVectors(B[eb[1]], B[eb[0]]);
      const ax = new THREE.Vector3().crossVectors(va, vb);
      if (ax.lengthSq() > 1e-18) axes.push(ax.normalize());
    }
  }

  for (const ax of axes) {
    if (!strictlyOverlapsOnAxis(A, B, ax, eps)) return false;
  }
  return true;
}

function initCache(scale) {
  const s = scale;
  const V = [
    v( 1,  1,  1).multiplyScalar(s),
    v( 1, -1, -1).multiplyScalar(s),
    v(-1,  1, -1).multiplyScalar(s),
    v(-1, -1,  1).multiplyScalar(s)
  ];
  const tets = [makeTetRecord(V, 1)];
  const exposed = [
    {a: V[0], b: V[2], c: V[1], opp: V[3], owner: 0, level: 1},
    {a: V[0], b: V[1], c: V[3], opp: V[2], owner: 0, level: 1},
    {a: V[0], b: V[3], c: V[2], opp: V[1], owner: 0, level: 1},
    {a: V[1], b: V[2], c: V[3], opp: V[0], owner: 0, level: 1}
  ];

  cache.length = 0;
  cache[1] = {
    depth: 1,
    tets,
    exposed,
    totalTets: 1
  };
}

function ensureDepth(d, customLimit = 0) {
  d = Math.max(1, Math.min(maxDepth, d));
  if (!cache[1]) initCache(1.0);

  // customLimit is used for step 2 (we only add 1 tetrahedron instead of all 4)
  for (let level = 2; level <= d; level++) {
    if (cache[level] && customLimit === 0) continue; 
    
    // If we're on step 2, we just manually create the level 2 cache with exactly 1 tet
    if (level === 2 && customLimit === 1) {
      const prev = cache[1];
      const tets = prev.tets.slice();
      const nextMap = new Map();
      
      // Keep all but the first face
      for(let i=1; i<prev.exposed.length; i++) {
        addOrCancelFace(nextMap, prev.exposed[i]);
      }
      
      const f = prev.exposed[0];
      const e = reflectPointAcrossPlane(f.opp, f.a, f.b, f.c);
      const candidateVerts = [f.a, f.b, f.c, e];
      const candidate = makeTetRecord(candidateVerts, level);
      
      const newIndex = tets.length;
      tets.push(candidate);
      
      addOrCancelFace(nextMap, {a: f.a, b: f.b, c: e, opp: f.c, owner: newIndex, level: level});
      addOrCancelFace(nextMap, {a: f.b, b: f.c, c: e, opp: f.a, owner: newIndex, level: level});
      addOrCancelFace(nextMap, {a: f.c, b: f.a, c: e, opp: f.b, owner: newIndex, level: level});
      
      cache[2] = { depth: 2, tets, exposed: Array.from(nextMap.values()), totalTets: tets.length };
      return;
    }

    const prev = cache[level-1];
    const tets = prev.tets.slice();
    const nextMap = new Map();

    for (const f of prev.exposed) {
      const e = reflectPointAcrossPlane(f.opp, f.a, f.b, f.c);
      const candidateVerts = [f.a, f.b, f.c, e];
      const candidate = makeTetRecord(candidateVerts, level);
      let blocked = false;

      if (level >= 4) {
        for (let i = 0; i < tets.length; i++) {
          if (i === f.owner) continue; 
          if (tetrahedraOverlap(candidate, tets[i])) {
            blocked = true;
            break;
          }
        }
      }

      if (blocked) {
        addOrCancelFace(nextMap, f);
        continue;
      }

      const newIndex = tets.length;
      tets.push(candidate);
      addOrCancelFace(nextMap, {a: f.a, b: f.b, c: e, opp: f.c, owner: newIndex, level: level});
      addOrCancelFace(nextMap, {a: f.b, b: f.c, c: e, opp: f.a, owner: newIndex, level: level});
      addOrCancelFace(nextMap, {a: f.c, b: f.a, c: e, opp: f.b, owner: newIndex, level: level});
    }

    cache[level] = { depth: level, tets, exposed: Array.from(nextMap.values()), totalTets: tets.length };
  }
}

// === Three.js Setup ===
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 5, 12);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.0;

const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(5, 10, 7);
scene.add(dirLight);

const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.5);
dirLight2.position.set(-5, -5, -7);
scene.add(dirLight2);

let currentMesh = null;
let currentEdges = null;
let currentVertices = null;
let activeHighlight = null;
const modelGroup = new THREE.Group();
scene.add(modelGroup);

const palette = [
  new THREE.Color("#ef476f"), new THREE.Color("#ffd166"),
  new THREE.Color("#06d6a0"), new THREE.Color("#118ab2"),
  new THREE.Color("#073b4c"), new THREE.Color("#9d4edd"),
  new THREE.Color("#ff9f1c"), new THREE.Color("#2ec4b6")
];

function buildMesh(d, limit = 0) {
  ensureDepth(d, limit);
  const state = cache[d];

  const positions = [];
  const colors = [];
  
  let colorMode = document.getElementById("color-mode").value;
  if(currentStep < 5) colorMode = "face";

  function colorForFace(f, i) {
    if (colorMode === "iteration") {
      const hue = ((f.level - 1) * 0.15) % 1.0;
      return new THREE.Color().setHSL(hue, 0.8, 0.6);
    }
    if (colorMode === "age") {
      const t = Math.max(0, Math.min(1, (f.level - 1) / Math.max(1, currentDepth - 1)));
      return new THREE.Color().setHSL(0.6 - 0.6*t, 0.85, 0.4 + 0.3*t);
    }
    return palette[i % palette.length];
  }

  for (let i = 0; i < state.exposed.length; i++) {
    const f = state.exposed[i];
    const col = colorForFace(f, i);

    const n = new THREE.Vector3().subVectors(f.b,f.a).cross(new THREE.Vector3().subVectors(f.c,f.a));
    const outward = new THREE.Vector3().subVectors(f.a, f.opp);
    let tri = [f.a, f.b, f.c];
    if (n.dot(outward) < 0) tri = [f.a, f.c, f.b];

    for (const p of tri) {
      positions.push(p.x, p.y, p.z);
      colors.push(col.r, col.g, col.b);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geom.computeVertexNormals();

  if (currentMesh) modelGroup.remove(currentMesh);
  if (currentEdges) modelGroup.remove(currentEdges);
  if (currentVertices) modelGroup.remove(currentVertices);

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 0.2,
    metalness: 0.1,
    transparent: true,
    opacity: 0.9,
  });

  currentMesh = new THREE.Mesh(geom, mat);
  modelGroup.add(currentMesh);

  const edgeGeom = new THREE.EdgesGeometry(geom, 15);
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 });
  currentEdges = new THREE.LineSegments(edgeGeom, edgeMat);
  modelGroup.add(currentEdges);

  // Collect unique vertices
  const uniqueVertsMap = new Map();
  for (const tet of state.tets) {
    for (const p of tet.verts) {
      uniqueVertsMap.set(pointKey(p), p);
    }
  }

  currentVertices = new THREE.Group();
  const sphereGeom = new THREE.SphereGeometry(0.12, 16, 16);
  const sphereMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.3
  });

  uniqueVertsMap.forEach((p) => {
    const mesh = new THREE.Mesh(sphereGeom, sphereMat.clone());
    mesh.position.copy(p);
    currentVertices.add(mesh);
  });
  modelGroup.add(currentVertices);

  applyHighlightStyles();

  document.getElementById("stat-tets").textContent = state.totalTets;
  document.getElementById("stat-faces").textContent = state.exposed.length;
}

function applyHighlightStyles() {
  if (!currentMesh || !currentEdges || !currentVertices) return;

  // Reset to defaults
  currentMesh.material.opacity = 0.9;
  currentMesh.material.transparent = true;
  if (currentMesh.material.emissive) {
    currentMesh.material.emissive.setHex(0x000000);
  }
  
  currentEdges.material.color.setHex(0xffffff);
  currentEdges.material.opacity = 0.3;

  currentVertices.children.forEach(child => {
    child.material.color.setHex(0xffffff);
    child.material.opacity = 0.3;
    child.scale.set(1, 1, 1);
  });

  // Apply active highlight
  if (activeHighlight === 'faces') {
    currentMesh.material.opacity = 1.0;
    if (currentMesh.material.emissive) {
      currentMesh.material.emissive.setHex(0x1a1a00); // subtle warm glow
    }
    currentEdges.material.opacity = 0.1;
    currentVertices.children.forEach(child => {
      child.material.opacity = 0.1;
    });
  } else if (activeHighlight === 'edges') {
    currentEdges.material.color.setHex(0x3b82f6); // accent blue
    currentEdges.material.opacity = 1.0;
    currentMesh.material.opacity = 0.15;
    currentVertices.children.forEach(child => {
      child.material.opacity = 0.1;
    });
  } else if (activeHighlight === 'vertices') {
    currentVertices.children.forEach(child => {
      child.material.color.setHex(0xec4899); // hot pink
      child.material.opacity = 1.0;
      child.scale.set(1.8, 1.8, 1.8);
    });
    currentMesh.material.opacity = 0.15;
    currentEdges.material.opacity = 0.1;
  }
}

function setHighlight(type) {
  if (activeHighlight === type) {
    activeHighlight = null;
  } else {
    activeHighlight = type;
  }

  // Update DOM active classes
  document.querySelectorAll('.highlight-trigger').forEach(el => {
    if (el.dataset.type === activeHighlight) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });

  applyHighlightStyles();
}

// === UI Interaction ===
function updateViewForStep() {
  activeHighlight = null;
  document.querySelectorAll('.highlight-trigger').forEach(el => el.classList.remove('active'));

  document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
  document.querySelector(`.step[data-step="${currentStep}"]`).classList.add('active');

  if (currentStep === 1) {
    currentDepth = 1;
    buildMesh(1);
    camera.position.set(0, 5, 8);
  } else if (currentStep === 2) {
    currentDepth = 2;
    buildMesh(2, 1); // custom limit = 1 to just attach one face
    camera.position.set(0, 5, 10);
  } else if (currentStep === 3) {
    cache[2] = null; // reset level 2 cache for full attachment
    currentDepth = 2;
    buildMesh(2);
    camera.position.set(0, 5, 14);
  } else if (currentStep === 4) {
    currentDepth = 4;
    buildMesh(4);
    camera.position.set(0, 10, 25);
  } else if (currentStep === 5) {
    currentDepth = parseInt(document.getElementById("depth-slider").value);
    buildMesh(currentDepth);
  }
}

document.querySelectorAll('.next-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentStep++;
    updateViewForStep();
  });
});

document.querySelectorAll('.skip-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentStep = 5;
    updateViewForStep();
  });
});

const resetBtn = document.querySelector('.reset-btn');
if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    currentStep = 1;
    updateViewForStep();
  });
}

document.getElementById("depth-slider").addEventListener("input", (e) => {
  document.getElementById("depth-val").textContent = e.target.value;
});

document.getElementById("depth-slider").addEventListener("change", (e) => {
  currentDepth = parseInt(e.target.value);
  buildMesh(currentDepth);
  camera.position.set(0, currentDepth*3, currentDepth*5 + 10);
});

document.getElementById("color-mode").addEventListener("change", () => {
  buildMesh(currentDepth);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Render Loop
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// Init
initCache(1.0);
updateViewForStep();

// Delegate highlight-trigger click events
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('.highlight-trigger');
  if (trigger) {
    const type = trigger.dataset.type;
    setHighlight(type);
  }
});

animate();
