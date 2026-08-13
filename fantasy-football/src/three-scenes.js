/* ============================================================================
   3D scenes.
   Built against the core three.js UMD bundle only — no examples/ modules, so
   no EffectComposer. "Bloom" is faked with additive sprite halos and emissive
   materials, which costs a fraction of a real post pass and lets the whole
   thing stay inside one HTML file.
   ========================================================================== */

/* -------------------------------------------------------------- shared env */

/**
 * Metal needs something to reflect or it renders black. There is no
 * RoomEnvironment in the core bundle, so we build a tiny studio out of
 * emissive planes and prefilter it with PMREM.
 */
function makeStudioEnv(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x0a0f1c);

  const panel = (color, intensity, w, h, pos, rot) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }),
    );
    m.position.set(...pos);
    if (rot) m.rotation.set(...rot);
    envScene.add(m);
  };

  // Key, fill, rim — plus a warm floor bounce so the gold reads as gold.
  panel(0xffffff, 3.2, 12, 12, [0, 9, 4], [-Math.PI / 2, 0, 0]);
  panel(0xffd27a, 2.4, 10, 8, [-8, 3, 3], [0, Math.PI / 2, 0]);
  panel(0x6fd0ff, 1.9, 10, 8, [8, 3, -1], [0, -Math.PI / 2, 0]);
  panel(0xff5f8f, 1.3, 9, 6, [0, 2, -8], [0, 0, 0]);
  panel(0x2a1c08, 1.0, 16, 16, [0, -4, 0], [Math.PI / 2, 0, 0]);

  const target = pmrem.fromScene(envScene, 0.03);
  pmrem.dispose();
  envScene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  return target.texture;
}

/** Soft radial sprite used for glows, light bloom and beam falloff. */
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,.55)');
  grad.addColorStop(0.55, 'rgba(255,255,255,.14)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ============================================================ Trophy build */

/**
 * A classic two-handled cup, revolved from a profile curve.
 * Proportions are hand-tuned: too tall reads as a vase, too wide as a bowl.
 */
function buildTrophy(env) {
  const group = new THREE.Group();

  const gold = new THREE.MeshStandardMaterial({
    color: 0xffc043, metalness: 1.0, roughness: 0.16,
    envMap: env, envMapIntensity: 1.5,
  });
  const darkGold = new THREE.MeshStandardMaterial({
    color: 0x8a6516, metalness: 1.0, roughness: 0.35, envMap: env, envMapIntensity: 1.1,
  });
  const marble = new THREE.MeshStandardMaterial({
    color: 0x161c2b, metalness: 0.3, roughness: 0.55, envMap: env, envMapIntensity: 0.7,
  });

  // --- Cup: profile in (radius, height)
  const pts = [];
  const P = (x, y) => pts.push(new THREE.Vector2(x, y));
  P(0.00, 1.30); P(0.86, 1.30); P(0.92, 1.22); P(0.95, 1.06);
  P(0.90, 0.80); P(0.74, 0.55); P(0.52, 0.34); P(0.34, 0.20);
  P(0.26, 0.10); P(0.24, 0.00);
  const cup = new THREE.Mesh(new THREE.LatheGeometry(pts, 96), gold);
  cup.castShadow = true;
  group.add(cup);

  // Inner surface so the cup does not look like an empty shell from above.
  const inner = new THREE.Mesh(
    new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p.x * 0.93, p.y * 0.985 + 0.02)), 64),
    darkGold,
  );
  inner.scale.setScalar(0.99);
  group.add(inner);

  // --- Handles. The torus arc is centred on +X and opens back toward the cup,
  // so each handle bows outward instead of crossing the cup face.
  const ARC = Math.PI * 1.15;
  const handleGeo = new THREE.TorusGeometry(0.33, 0.058, 18, 56, ARC);
  for (const side of [1, -1]) {
    const h = new THREE.Mesh(handleGeo, gold);
    h.rotation.z = -ARC / 2;
    h.castShadow = true;
    // Mirror via a 180° pivot, not a negative scale — negative scale inverts
    // the winding order and the handle would render inside-out.
    const pivot = new THREE.Group();
    pivot.add(h);
    pivot.position.set(side * 0.80, 0.92, 0);
    if (side < 0) pivot.rotation.y = Math.PI;
    group.add(pivot);
  }

  // --- Stem and base
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.34, 32), gold);
  stem.position.y = -0.16;
  group.add(stem);

  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.16, 32, 24), gold);
  knob.position.y = -0.05;
  group.add(knob);

  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.52, 0.14, 48), gold);
  plinth.position.y = -0.40;
  plinth.castShadow = true;
  group.add(plinth);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.68, 0.22, 48), marble);
  base.position.y = -0.58;
  base.castShadow = true;
  group.add(base);

  // Nameplate on the base front.
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.12, 0.02), darkGold);
  plate.position.set(0, -0.58, 0.68);
  group.add(plate);

  group.position.y = 0.35;
  return group;
}

/** A football, for the confetti burst and idle orbit. */
function buildFootball(env) {
  const geo = new THREE.SphereGeometry(0.5, 32, 24);
  geo.scale(1, 0.62, 0.62);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x7a3b18, metalness: 0.1, roughness: 0.65, envMap: env, envMapIntensity: 0.8,
  });
  const ball = new THREE.Mesh(geo, mat);

  const laceMat = new THREE.MeshStandardMaterial({ color: 0xf2ede4, roughness: 0.7 });
  const lace = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.035, 0.035), laceMat);
  lace.position.y = 0.31;
  ball.add(lace);
  for (let i = -2; i <= 2; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.028, 0.10), laceMat);
    s.position.set(i * 0.062, 0.315, 0);
    ball.add(s);
  }
  // Stripes near each end.
  for (const x of [-0.31, 0.31]) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.196, 0.016, 8, 40), laceMat);
    r.rotation.y = Math.PI / 2;
    r.position.x = x;
    ball.add(r);
  }
  return ball;
}

/* ==================================================== Winner ceremony scene */

export class Ceremony {
  constructor(canvas) {
    this.canvas = canvas;
    this.running = false;
    this.raf = null;
    this.clock = null;
  }

  init() {
    if (this.renderer) return;

    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x03060c);
    scene.fog = new THREE.FogExp2(0x03060c, 0.055);
    this.scene = scene;

    this.env = makeStudioEnv(renderer);
    this.glow = glowTexture();

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 120);
    camera.position.set(0, 1.5, 7.2);
    this.camera = camera;

    // ---- Lighting
    scene.add(new THREE.AmbientLight(0x2a3a5c, 0.7));

    const key = new THREE.SpotLight(0xfff0d0, 260, 30, Math.PI / 7, 0.45, 1.6);
    key.position.set(3.4, 9, 4.6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0012;
    scene.add(key, key.target);

    const rim = new THREE.SpotLight(0x4cc9f0, 150, 30, Math.PI / 6, 0.6, 1.6);
    rim.position.set(-5, 6, -4);
    scene.add(rim, rim.target);

    const warm = new THREE.PointLight(0xff9f45, 40, 16, 2);
    warm.position.set(-2.6, 1.4, 2.6);
    scene.add(warm);

    // ---- Stage floor
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x070c16, metalness: 0.62, roughness: 0.34, envMap: this.env, envMapIntensity: 0.55,
    });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(15, 72), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.05;
    floor.receiveShadow = true;
    scene.add(floor);

    // Glowing ring around the podium.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.85, 2.0, 96),
      new THREE.MeshBasicMaterial({ color: 0xffc531, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -1.04;
    scene.add(ring);
    this.ring = ring;

    // Podium.
    const podium = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.68, 0.5, 64),
      new THREE.MeshStandardMaterial({ color: 0x0d1424, metalness: 0.5, roughness: 0.42, envMap: this.env }),
    );
    podium.position.y = -0.8;
    podium.castShadow = podium.receiveShadow = true;
    scene.add(podium);

    // ---- Trophy
    this.trophy = buildTrophy(this.env);
    this.trophy.position.y = 0.42;
    scene.add(this.trophy);
    key.target.position.set(0, 0.5, 0);
    rim.target.position.set(0, 0.5, 0);

    // Halo behind the trophy sells the "glow" without a bloom pass.
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glow, color: 0xffc531, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    halo.scale.set(7, 7, 1);
    halo.position.set(0, 0.6, -1.4);
    scene.add(halo);
    this.halo = halo;

    // ---- Light beams sweeping the stage
    this.beams = [];
    const beamGeo = new THREE.ConeGeometry(1.5, 11, 28, 1, true);
    for (let i = 0; i < 5; i++) {
      const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
        color: [0xffc531, 0x4cc9f0, 0x00e5a0, 0xff2d6f, 0xffffff][i],
        transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide,
      }));
      beam.position.set(Math.cos(i * 1.9) * 4.2, 5.2, Math.sin(i * 1.9) * 3.2);
      beam.userData.phase = i * 1.3;
      scene.add(beam);
      this.beams.push(beam);
    }

    // ---- Orbiting footballs
    this.balls = [];
    for (let i = 0; i < 3; i++) {
      const b = buildFootball(this.env);
      b.scale.setScalar(0.5);
      b.userData = { a: (i / 3) * Math.PI * 2, r: 3.1 + i * 0.22, y: 0.5 + i * 0.55, spin: 0.9 + i * 0.4 };
      scene.add(b);
      this.balls.push(b);
    }

    this.initConfetti();
    this.initStars();

    this.onResize = () => this.resize();
    addEventListener('resize', this.onResize);
  }

  /** Instanced confetti — one draw call for a few thousand ribbons. */
  initConfetti() {
    const COUNT = 1400;
    const geo = new THREE.PlaneGeometry(0.11, 0.17);
    const mat = new THREE.MeshStandardMaterial({
      side: THREE.DoubleSide, metalness: 0.45, roughness: 0.35,
      envMap: this.env, envMapIntensity: 1.0, vertexColors: true,
    });

    const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;

    const palette = [0xffc531, 0x00e5a0, 0x4cc9f0, 0xff2d6f, 0xb892ff, 0xffffff].map((c) => new THREE.Color(c));
    const colors = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      palette[i % palette.length].toArray(colors, i * 3);
    }
    geo.setAttribute('color', new THREE.InstancedBufferAttribute(colors, 3));

    this.confetti = mesh;
    this.confettiState = new Array(COUNT);
    for (let i = 0; i < COUNT; i++) this.confettiState[i] = this.spawnConfetti(true);
    this.scene.add(mesh);
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
  }

  spawnConfetti(initial) {
    const spread = 9;
    return {
      x: (Math.random() - 0.5) * spread,
      y: initial ? Math.random() * 12 + 1 : 9 + Math.random() * 5,
      z: (Math.random() - 0.5) * spread - 1,
      vx: (Math.random() - 0.5) * 0.5,
      vy: -0.9 - Math.random() * 1.5,
      vz: (Math.random() - 0.5) * 0.5,
      rx: Math.random() * Math.PI, ry: Math.random() * Math.PI, rz: Math.random() * Math.PI,
      drx: (Math.random() - 0.5) * 4, dry: (Math.random() - 0.5) * 4, drz: (Math.random() - 0.5) * 4,
      sway: Math.random() * Math.PI * 2,
    };
  }

  /** Distant sparkle field for depth. */
  initStars() {
    const N = 420;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 16 + Math.random() * 22;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.random() * Math.PI * 0.55;
      pos[i * 3] = Math.cos(th) * Math.sin(ph) * r;
      pos[i * 3 + 1] = Math.cos(ph) * r * 0.7 + 2;
      pos[i * 3 + 2] = Math.sin(th) * Math.sin(ph) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.12, map: this.glow, color: 0xbfd8ff, transparent: true,
      opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.scene.add(this.stars);
  }

  resize() {
    if (!this.renderer) return;
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    this.init();
    this.resize();
    this.running = true;
    this.t0 = performance.now();
    this.clock = this.clock || new THREE.Clock();
    this.clock.start();
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.clock) this.clock.stop();
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = (performance.now() - this.t0) / 1000;

    // Camera: slow dolly in, then a gentle drift. The look-at sits high so the
    // trophy rides in the upper half and the lower third stays clear for text.
    const ease = 1 - Math.pow(1 - Math.min(t / 2.6, 1), 3);
    const dist = 10.2 - ease * 2.2;
    this.camera.position.x = Math.sin(t * 0.16) * 0.9;
    this.camera.position.y = 1.9 + Math.sin(t * 0.23) * 0.16 + (1 - ease) * 0.7;
    this.camera.position.z = dist;
    this.camera.lookAt(0, 1.15, 0);

    // Trophy: spin plus a slow bob.
    this.trophy.rotation.y = t * 0.55;
    this.trophy.position.y = 0.42 + Math.sin(t * 1.25) * 0.055;

    this.ring.material.opacity = 0.4 + Math.sin(t * 2.1) * 0.16;
    this.ring.scale.setScalar(1 + Math.sin(t * 1.4) * 0.015);
    this.halo.material.opacity = 0.42 + Math.sin(t * 1.7) * 0.1;

    for (const beam of this.beams) {
      const p = beam.userData.phase;
      beam.rotation.z = Math.sin(t * 0.5 + p) * 0.32;
      beam.rotation.x = Math.cos(t * 0.38 + p) * 0.22;
      beam.material.opacity = 0.05 + (Math.sin(t * 1.1 + p) * 0.5 + 0.5) * 0.07;
    }

    for (const b of this.balls) {
      const u = b.userData;
      u.a += dt * 0.42;
      b.position.set(Math.cos(u.a) * u.r, u.y + Math.sin(t * 0.9 + u.a) * 0.25, Math.sin(u.a) * u.r * 0.72);
      b.rotation.x += dt * u.spin;
      b.rotation.z += dt * u.spin * 0.6;
    }

    this.stars.rotation.y = t * 0.012;
    this.updateConfetti(dt, t);

    this.renderer.render(this.scene, this.camera);
  }

  updateConfetti(dt, t) {
    const st = this.confettiState;
    for (let i = 0; i < st.length; i++) {
      const p = st[i];
      p.sway += dt * 2.4;
      p.x += (p.vx + Math.sin(p.sway) * 0.55) * dt;
      p.y += p.vy * dt;
      p.z += (p.vz + Math.cos(p.sway * 0.8) * 0.35) * dt;
      p.rx += p.drx * dt; p.ry += p.dry * dt; p.rz += p.drz * dt;

      if (p.y < -1.2) st[i] = this.spawnConfetti(false);

      this._e.set(p.rx, p.ry, p.rz);
      this._q.setFromEuler(this._e);
      this._v.set(p.x, p.y, p.z);
      this._m4.compose(this._v, this._q, this._s);
      this.confetti.setMatrixAt(i, this._m4);
    }
    this.confetti.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.stop();
    removeEventListener('resize', this.onResize);
    if (this.renderer) {
      this.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => { Object.values(m).forEach((v) => v && v.isTexture && v.dispose()); m.dispose(); });
        }
      });
      this.renderer.dispose();
      this.renderer = null;
    }
  }
}

/* ================================================== Gate hero: field of light */

export class HeroField {
  constructor(canvas) {
    this.canvas = canvas;
    this.running = false;
    this.mouse = { x: 0, y: 0 };
  }

  start() {
    if (this.renderer) { this.running = true; this.loop(); return; }

    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05080f, 0.035);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 220);
    camera.position.set(0, 3.6, 13);
    camera.lookAt(0, 0, -22);
    this.camera = camera;

    // Receding field: yard lines that scroll toward the viewer.
    const lineMat = new THREE.LineBasicMaterial({ color: 0x1d6f57, transparent: true, opacity: 0.55 });
    const field = new THREE.Group();
    this.yardLines = [];
    for (let i = 0; i < 44; i++) {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-16, 0, 0), new THREE.Vector3(16, 0, 0),
      ]);
      const l = new THREE.Line(g, lineMat.clone());
      l.position.z = -i * 4.2;
      field.add(l);
      this.yardLines.push(l);
    }
    // Sidelines.
    for (const x of [-16, 16]) {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, 0, 12), new THREE.Vector3(x, 0, -180),
      ]);
      field.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x27a37c, transparent: true, opacity: 0.4 })));
    }
    field.position.y = -2.6;
    scene.add(field);
    this.field = field;

    // Drifting motes.
    const N = 340;
    const pos = new Float32Array(N * 3);
    this.motes = [];
    for (let i = 0; i < N; i++) {
      const p = { x: (Math.random() - 0.5) * 44, y: Math.random() * 16 - 3, z: -Math.random() * 130 + 10, s: 0.2 + Math.random() * 0.6 };
      this.motes.push(p);
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.30, map: glowTexture(), color: 0x63f5c4, transparent: true,
      opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    scene.add(this.points);

    this.onMove = (e) => {
      this.mouse.x = (e.clientX / innerWidth - 0.5) * 2;
      this.mouse.y = (e.clientY / innerHeight - 0.5) * 2;
    };
    this.onResize = () => this.resize();
    addEventListener('pointermove', this.onMove, { passive: true });
    addEventListener('resize', this.onResize);

    this.clock = new THREE.Clock();
    this.running = true;
    this.resize();
    this.loop();
  }

  resize() {
    if (!this.renderer) return;
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  loop() {
    if (!this.running) return;
    this.raf = requestAnimationFrame(() => this.loop());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    // Scroll yard lines forward, recycling them behind the camera.
    for (const l of this.yardLines) {
      l.position.z += dt * 6.5;
      if (l.position.z > 14) l.position.z -= 44 * 4.2;
      const d = Math.abs(l.position.z + 60) / 90;
      l.material.opacity = Math.max(0, 0.6 - d * 0.5);
    }

    const arr = this.points.geometry.attributes.position.array;
    for (let i = 0; i < this.motes.length; i++) {
      const p = this.motes[i];
      p.z += dt * 4.2 * p.s;
      p.y += Math.sin(t * 0.6 + i) * dt * 0.22;
      if (p.z > 12) { p.z = -130; p.x = (Math.random() - 0.5) * 44; }
      arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
    }
    this.points.geometry.attributes.position.needsUpdate = true;

    // Parallax.
    this.camera.position.x += (this.mouse.x * 1.6 - this.camera.position.x) * 0.035;
    this.camera.position.y += (3.6 - this.mouse.y * 0.9 - this.camera.position.y) * 0.035;
    this.camera.lookAt(0, 0.4, -24);

    this.renderer.render(this.scene, this.camera);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }
}

/* ============================================ Lightweight 2D pick confetti */

/**
 * Draft picks fire many times a minute, so they get a cheap 2D burst rather
 * than spinning up a second WebGL context.
 */
export function pickBurst(color = '#00e5a0') {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:120';
  canvas.width = innerWidth; canvas.height = innerHeight;
  document.body.appendChild(canvas);
  const g = canvas.getContext('2d');

  const colors = [color, '#ffc531', '#ffffff', '#4cc9f0'];
  const parts = [];
  const cx = innerWidth / 2, cy = innerHeight * 0.34;
  for (let i = 0; i < 110; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 5 + Math.random() * 13;
    parts.push({
      x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 4,
      w: 4 + Math.random() * 6, h: 7 + Math.random() * 9,
      rot: Math.random() * 6.28, dr: (Math.random() - 0.5) * 0.4,
      c: colors[(Math.random() * colors.length) | 0], life: 1,
    });
  }

  let raf;
  const tick = () => {
    g.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    for (const p of parts) {
      p.vy += 0.42;
      p.vx *= 0.99;
      p.x += p.vx; p.y += p.vy; p.rot += p.dr;
      p.life -= 0.0125;
      if (p.life <= 0) continue;
      alive = true;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.globalAlpha = Math.max(0, p.life);
      g.fillStyle = p.c;
      g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      g.restore();
    }
    if (alive) raf = requestAnimationFrame(tick);
    else { cancelAnimationFrame(raf); canvas.remove(); }
  };
  tick();
}
