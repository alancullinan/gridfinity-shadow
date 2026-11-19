import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Manifold } from 'manifold-3d';

export type CameraView = 'iso' | 'top' | 'front';

/** 3D model viewer. Renders on demand (only when something changes) to save power. */
export class Preview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 1, 8000);
  private controls: OrbitControls;
  private mesh: THREE.Mesh | null = null;
  private grid: THREE.GridHelper | null = null;
  private material = new THREE.MeshStandardMaterial({ color: 0x5b8def, roughness: 0.6, metalness: 0 });
  private center = new THREE.Vector3();
  private halfSize = new THREE.Vector3(50, 50, 20);
  private sizeKey = '';
  private view: CameraView = 'iso';
  private queued = false;
  /** Set once the user orbits/zooms; until then the camera keeps re-fitting the model. */
  private userMoved = false;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    // Render a little above screen resolution: it's on-demand, and it keeps fine edges clean.
    this.renderer.setPixelRatio(Math.min(2, Math.max(1.5, window.devicePixelRatio)));
    container.appendChild(this.renderer.domElement);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.8;
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-120, -160, 260);
    this.scene.add(key);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.render());
    this.controls.addEventListener('start', () => (this.userMoved = true));
    new ResizeObserver(() => this.resize()).observe(container);
    this.setView('iso');
  }

  /** Schedules one frame (and keeps going while the camera is still easing). */
  render() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      const moving = this.controls.update();
      this.renderer.render(this.scene, this.camera);
      if (moving) this.render();
    });
  }

  setTheme(opts: { background: string; gridMajor: string; gridMinor: string; model: string }) {
    this.scene.background = new THREE.Color(opts.background);
    this.material.color = new THREE.Color(opts.model);
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose();
    }
    this.grid = new THREE.GridHelper(840, 20, new THREE.Color(opts.gridMajor), new THREE.Color(opts.gridMinor));
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.z = -0.05;
    this.scene.add(this.grid);
    this.render();
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.userMoved) this.setView(this.view);
    else this.render();
  }

  setView(view: CameraView) {
    this.view = view;
    this.userMoved = false;
    const dir =
      view === 'top' ? new THREE.Vector3(0, -0.0001, 1) : view === 'front' ? new THREE.Vector3(0, -1, 0.32) : new THREE.Vector3(0.9, -1.25, 1.05);
    dir.normalize();
    // Distance that fits all eight corners of the model's box in view, with a margin.
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360) * 0.86;
    const tanH = tanV * this.camera.aspect;
    const fwd = dir.clone().negate();
    const worldUp = Math.abs(dir.z) > 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const right = new THREE.Vector3().crossVectors(fwd, worldUp).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd);
    let dist = 10;
    const h = this.halfSize;
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1]) {
          const p = new THREE.Vector3(sx * h.x, sy * h.y, sz * h.z);
          const toward = p.dot(dir); // how far the corner sits towards the camera
          dist = Math.max(dist, toward + Math.abs(p.dot(right)) / tanH, toward + Math.abs(p.dot(up)) / tanV);
        }
    this.controls.target.copy(this.center);
    this.camera.position.copy(this.center).add(dir.multiplyScalar(dist));
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
  }

  show(m: Manifold) {
    const geom = shadedGeometry(m);
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.mesh = new THREE.Mesh(geom, this.material);
    this.scene.add(this.mesh);
    // Re-frame only when the bin's size changes, so editing doesn't move the camera.
    const b = geom.boundingBox!;
    const key = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => Math.round(v)).join('x');
    if (key !== this.sizeKey) {
      this.sizeKey = key;
      b.getCenter(this.center);
      b.getSize(this.halfSize).multiplyScalar(0.5);
      this.setView(this.view);
    }
    this.render();
  }
}

/**
 * Non-indexed geometry with normals that keep large flat faces crisp while smoothing across
 * clusters of tiny faces (the thin slices that make up fillets and chamfers), so rounded edges
 * look smooth instead of striped.
 */
function shadedGeometry(m: Manifold): THREE.BufferGeometry {
  const mesh = m.getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts;
  const nTri = tv.length / 3, nVert = mesh.numVert;
  const fn = new Float32Array(nTri * 3); // unit face normals
  const area = new Float32Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const a = tv[t * 3] * np, b = tv[t * 3 + 1] * np, c = tv[t * 3 + 2] * np;
    const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
    const wx = vp[c] - vp[a], wy = vp[c + 1] - vp[a + 1], wz = vp[c + 2] - vp[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    fn[t * 3] = nx / len;
    fn[t * 3 + 1] = ny / len;
    fn[t * 3 + 2] = nz / len;
    area[t] = len / 2;
  }
  // Triangles around each vertex (CSR layout).
  const count = new Uint32Array(nVert + 1);
  for (let i = 0; i < tv.length; i++) count[tv[i] + 1]++;
  for (let v = 0; v < nVert; v++) count[v + 1] += count[v];
  const fill = count.slice(0, nVert);
  const around = new Uint32Array(tv.length);
  for (let i = 0; i < tv.length; i++) around[fill[tv[i]]++] = (i / 3) | 0;

  // Slice faces are tiny or very narrow (a long straight edge gives long, 0.15 mm-wide strips).
  const thin = new Uint8Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const i = [tv[t * 3] * np, tv[t * 3 + 1] * np, tv[t * 3 + 2] * np];
    let longest = 0;
    for (let k = 0; k < 3; k++) {
      const a = i[k], b = i[(k + 1) % 3];
      longest = Math.max(longest, Math.hypot(vp[b] - vp[a], vp[b + 1] - vp[a + 1], vp[b + 2] - vp[a + 2]));
    }
    thin[t] = area[t] < 0.15 || (2 * area[t]) / (longest || 1) < 0.3 ? 1 : 0;
  }
  const SMALL = 0.15;
  // Smooth only at vertices surrounded entirely by thin faces (inside a fillet); where a thin
  // face meets a real face (e.g. a long sliver of the flat top), keep the shading flat.
  const allThin = new Uint8Array(nVert);
  for (let v = 0; v < nVert; v++) {
    let ok = 1;
    for (let j = count[v]; j < count[v + 1] && ok; j++) if (!thin[around[j]]) ok = 0;
    allThin[v] = ok;
  }
  const COS_FLAT = Math.cos((25 * Math.PI) / 180);
  const COS_SMOOTH = Math.cos((100 * Math.PI) / 180);
  const pos = new Float32Array(nTri * 9), nor = new Float32Array(nTri * 9);
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const v = tv[t * 3 + k];
      const small = thin[t] === 1 && allThin[v] === 1;
      let sx = 0, sy = 0, sz = 0;
      for (let j = count[v]; j < count[v + 1]; j++) {
        const u = around[j];
        const dot = fn[t * 3] * fn[u * 3] + fn[t * 3 + 1] * fn[u * 3 + 1] + fn[t * 3 + 2] * fn[u * 3 + 2];
        const join = small ? (thin[u] ? dot > COS_SMOOTH : dot > COS_FLAT) : dot > COS_FLAT;
        if (!join) continue;
        // Weight small faces up so they don't get swamped by a big neighbour.
        const w = small ? Math.min(Math.max(area[u], SMALL), 1) : area[u];
        sx += fn[u * 3] * w;
        sy += fn[u * 3 + 1] * w;
        sz += fn[u * 3 + 2] * w;
      }
      const len = Math.hypot(sx, sy, sz) || 1;
      const o = (t * 3 + k) * 3;
      pos[o] = vp[v * np];
      pos[o + 1] = vp[v * np + 1];
      pos[o + 2] = vp[v * np + 2];
      nor[o] = sx / len;
      nor[o + 1] = sy / len;
      nor[o + 2] = sz / len;
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return geom;
}
