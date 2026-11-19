import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Manifold } from 'manifold-3d';

export class Preview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
  private controls: OrbitControls;
  private mesh: THREE.Mesh | null = null;
  private framedRadius = 0;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    container.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(120, -160, 140);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(80, -120, 200);
    this.scene.add(sun);
    const grid = new THREE.GridHelper(420, 10, 0x888888, 0xcccccc);
    grid.rotation.x = Math.PI / 2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    this.scene.add(grid);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  setBackground(color: string) {
    this.scene.background = new THREE.Color(color);
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  show(m: Manifold) {
    const mesh = m.getMesh();
    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array(mesh.numVert * 3);
    for (let i = 0; i < mesh.numVert; i++)
      for (let k = 0; k < 3; k++) pos[i * 3 + k] = mesh.vertProperties[i * mesh.numProp + k];
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1));
    const nonIndexed = geom.toNonIndexed();
    nonIndexed.computeVertexNormals();
    geom.dispose();
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.mesh = new THREE.Mesh(nonIndexed, new THREE.MeshStandardMaterial({ color: 0x3d8bfd, roughness: 0.55, metalness: 0.05 }));
    this.scene.add(this.mesh);
    nonIndexed.computeBoundingSphere();
    const r = nonIndexed.boundingSphere!.radius;
    if (Math.abs(r - this.framedRadius) > this.framedRadius * 0.15) {
      this.framedRadius = r;
      const c = nonIndexed.boundingSphere!.center;
      this.controls.target.copy(c);
      this.camera.position.set(c.x + r * 1.3, c.y - r * 1.9, c.z + r * 1.7);
    }
  }
}
