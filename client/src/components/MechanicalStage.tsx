import { useEffect, useRef, useState } from "react";
import { Maximize2, Pause, Play, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { isCommonsModel, safeCommonsAssetUrl, type CommonsModel } from "../lib/models";

function spurGear(teeth: number, radius: number, depth: number, material: THREE.Material) {
  const shape = new THREE.Shape();
  const step = (Math.PI * 2) / teeth;
  for (let tooth = 0; tooth < teeth; tooth += 1) {
    const points: [number, number][] = [
      [radius * 0.82, (tooth + 0.16) * step],
      [radius, (tooth + 0.27) * step],
      [radius, (tooth + 0.71) * step],
      [radius * 0.82, (tooth + 0.82) * step],
    ];
    points.forEach(([distance, angle], index) => {
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance;
      if (tooth === 0 && index === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
  }
  shape.closePath();
  const bore = new THREE.Path();
  bore.absarc(0, 0, radius * 0.22, 0, Math.PI * 2, true);
  shape.holes.push(bore);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: Math.min(radius * 0.025, 0.025),
    bevelThickness: Math.min(depth * 0.12, 0.025),
    curveSegments: 2,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function cylinderAlongZ(radius: number, length: number, material: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 32), material);
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

function buildAssembly() {
  const group = new THREE.Group();
  const violet = new THREE.MeshStandardMaterial({ color: 0xa990ff, metalness: 0.65, roughness: 0.32 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x92909d, metalness: 0.82, roughness: 0.27 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: 0x393742, metalness: 0.72, roughness: 0.35 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc29c66, metalness: 0.75, roughness: 0.3 });

  const drive = new THREE.Group();
  drive.name = "drive-gear";
  const mainGear = spurGear(18, 0.91, 0.25, violet);
  drive.add(mainGear);
  const boss = cylinderAlongZ(0.31, 0.32, steel);
  boss.position.z = 0.035;
  drive.add(boss);
  const axle = cylinderAlongZ(0.105, 0.86, brass);
  axle.position.z = 0.11;
  drive.add(axle);
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2;
    const stud = cylinderAlongZ(0.045, 0.035, darkSteel);
    stud.position.set(Math.cos(angle) * 0.56, Math.sin(angle) * 0.56, 0.155);
    drive.add(stud);
  }
  drive.position.set(-0.65, 0.28, 0);
  group.add(drive);

  const follower = new THREE.Group();
  follower.name = "follower-gear";
  const smallGear = spurGear(14, 0.7, 0.22, steel);
  follower.add(smallGear);
  const hub = cylinderAlongZ(0.255, 0.3, brass);
  hub.position.z = 0.025;
  follower.add(hub);
  const smallAxle = cylinderAlongZ(0.09, 0.8, darkSteel);
  smallAxle.position.z = 0.12;
  follower.add(smallAxle);
  follower.position.set(0.67, -0.32, 0.02);
  group.add(follower);

  const plate = new THREE.Mesh(new THREE.BoxGeometry(3.65, 0.24, 0.17), darkSteel);
  plate.position.set(0, -1.33, -0.21);
  group.add(plate);

  [-0.95, 0.95].forEach((x) => {
    const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.46, 0.35), darkSteel);
    pedestal.position.set(x, -1.05, -0.1);
    group.add(pedestal);
    const saddle = cylinderAlongZ(0.36, 0.34, steel);
    saddle.position.set(x, -0.84, 0.02);
    group.add(saddle);
    const bearingRace = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.048, 12, 36), brass);
    bearingRace.position.set(x, -0.84, 0.205);
    group.add(bearingRace);
  });

  const labelPin = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), brass);
  labelPin.position.set(1.55, 0.86, 0.09);
  group.add(labelPin);
  return { group, drive, follower };
}

export function MechanicalStage({ model, compact = false }: { model?: CommonsModel | null; compact?: boolean }) {
  const host = useRef<HTMLDivElement | null>(null);
  const controls = useRef<OrbitControls | null>(null);
  const playingRef = useRef(typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [playing, setPlaying] = useState(playingRef.current);
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);
  const [viewerUnavailable, setViewerUnavailable] = useState(false);

  useEffect(() => {
    playingRef.current = playing;
    if (controls.current) controls.current.autoRotate = playing;
  }, [playing]);

  useEffect(() => {
    const mount = host.current;
    if (!mount) return;

    setMessage("");
    setReady(false);
    setViewerUnavailable(false);
    if (model && !isCommonsModel(model)) {
      setMessage("This saved model does not contain verifiable open-library source, creator, license, format, and size details.");
      setReady(true);
      setViewerUnavailable(true);
      return;
    }

    let disposed = false;
    let activeAsset: THREE.Object3D | null = null;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0c0a16");
    scene.add(new THREE.HemisphereLight(0xd9d0ff, 0x26222d, 2.1));

    const keyLight = new THREE.DirectionalLight(0xfff3df, 3.1);
    keyLight.position.set(-4, 5, 8);
    scene.add(keyLight);
    const violetLight = new THREE.PointLight(0x9773ff, 16, 8, 2);
    violetLight.position.set(3, -1, 3);
    scene.add(violetLight);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(3.6, 3.05, 6.9);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power" });
    } catch {
      setMessage("3D preview is unavailable in this browser. Your study notes and learning tools still work here.");
      setReady(true);
      setViewerUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
    renderer.setSize(mount.clientWidth, mount.clientHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    mount.replaceChildren(renderer.domElement);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, -0.14, 0);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.075;
    orbit.minDistance = 3.4;
    orbit.maxDistance = 11;
    orbit.autoRotate = playingRef.current;
    orbit.autoRotateSpeed = 0.8;
    orbit.addEventListener("start", () => setPlaying(false));
    controls.current = orbit;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({ color: 0x0c0a16, roughness: 0.9, metalness: 0.04 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.7;
    floor.receiveShadow = true;
    scene.add(floor);

    const demo = buildAssembly();
    demo.group.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    scene.add(demo.group);

    const resize = () => {
      if (!mount || disposed) return;
      camera.aspect = Math.max(0.1, mount.clientWidth / Math.max(mount.clientHeight, 1));
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    if (model) {
      const loader = new STLLoader();
      const url = model.modelUrl;
      const title = model.title.toLowerCase();
      const handleFailure = () => {
        if (!disposed) {
          setMessage("This file or one of its included resources could not be loaded. Only resources hosted by the verified source library are opened by the viewer.");
          setReady(true);
        }
      };
      if (model.format === "STL") {
        loader.load(
          url,
          (geometry) => {
            if (disposed) { geometry.dispose(); return; }
            geometry.computeVertexNormals();
            const bounds = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position as THREE.BufferAttribute);
            const center = bounds.getCenter(new THREE.Vector3());
            const size = bounds.getSize(new THREE.Vector3());
            const span = Math.max(size.x, size.y, size.z);
            geometry.translate(-center.x, -center.y, -center.z);
            const asset = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: title.includes("gear") ? 0xa990ff : 0xaaa6b6, metalness: 0.57, roughness: 0.32, side: THREE.DoubleSide }));
            asset.scale.setScalar(2.4 / Math.max(span, 1e-4));
            asset.rotation.x = -Math.PI / 2;
            asset.castShadow = true;
            asset.receiveShadow = true;
            demo.group.visible = false;
            activeAsset = asset;
            scene.add(asset);
            setReady(true);
          },
          undefined,
          handleFailure,
        );
      } else {
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((resource) => safeCommonsAssetUrl(resource, url, window.location.origin) ?? "data:application/octet-stream;base64,");
        new GLTFLoader(manager).load(
          url,
          (gltf) => {
            if (disposed) return;
            const bounds = new THREE.Box3().setFromObject(gltf.scene);
            const center = bounds.getCenter(new THREE.Vector3());
            const size = bounds.getSize(new THREE.Vector3());
            gltf.scene.position.sub(center);
            gltf.scene.scale.setScalar(2.4 / Math.max(size.x, size.y, size.z, 1e-4));
            gltf.scene.traverse((node) => { if ((node as THREE.Mesh).isMesh) { node.castShadow = true; node.receiveShadow = true; } });
            demo.group.visible = false;
            activeAsset = gltf.scene;
            scene.add(gltf.scene);
            setReady(true);
          },
          undefined,
          handleFailure,
        );
      }
    } else {
      setReady(true);
    }

    let frame = 0;
    const animate = () => {
      if (disposed) return;
      frame = window.requestAnimationFrame(animate);
      if (playingRef.current) {
        demo.drive.rotation.z += 0.0018;
        demo.follower.rotation.z -= 0.0024;
        if (activeAsset) activeAsset.rotation.y += 0.0013;
      }
      orbit.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      orbit.dispose();
      controls.current = null;
      demo.group.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
        else mesh.material?.dispose();
      });
      if (activeAsset) {
        activeAsset.traverse((node) => {
          const mesh = node as THREE.Mesh;
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
          else if (mesh.material) mesh.material.dispose();
        });
      }
      floor.geometry.dispose();
      if (Array.isArray(floor.material)) floor.material.forEach((material) => material.dispose());
      else floor.material.dispose();
      renderer.dispose();
      mount.replaceChildren();
    };
    // The canvas is intentionally reconstructed only when the model or motion state changes.
  }, [model?.id, model?.modelUrl, model?.format]);

  const resetView = () => {
    if (!controls.current) return;
    controls.current.reset();
    controls.current.target.set(0, -0.14, 0);
  };

  return (
    <div className={`mechanical-stage ${compact ? "mechanical-stage--compact" : ""}`}>
      <div className="stage-grid" aria-hidden="true" />
      <div className="stage-caption">
        <span className="stage-mark"><span className="stage-mark-dot" /> {model ? model.format : "FIG. 01"}</span>
        <span>{model ? "INTERACTIVE PREVIEW" : "DRIVE ASSEMBLY · 18/14T"}</span>
      </div>
      {!ready && <div className="stage-loader" aria-live="polite"><span className="spinner-line" /> Fetching mesh</div>}
      <div ref={host} className="stage-canvas" aria-label={model ? `3D viewer for ${model.title}` : "Animated 3D gear and bearing assembly"} aria-hidden={viewerUnavailable ? true : undefined} role={viewerUnavailable ? undefined : "img"} />
      {message && <div className={`stage-error ${viewerUnavailable ? "stage-error--unavailable" : ""}`} role="status">{message}</div>}
      {!viewerUnavailable && <div className="stage-controls" aria-label="3D model controls">
        <button type="button" className="stage-control-button" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "Pause rotation" : "Resume rotation"} title={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <span className="stage-control-divider" />
        <button type="button" className="stage-control-button" onClick={() => { if (controls.current) controls.current.dollyIn(1.18); }} aria-label="Zoom in" title="Zoom in"><ZoomIn size={15} /></button>
        <button type="button" className="stage-control-button" onClick={() => { if (controls.current) controls.current.dollyOut(1.18); }} aria-label="Zoom out" title="Zoom out"><ZoomOut size={15} /></button>
        <button type="button" className="stage-control-button" onClick={resetView} aria-label="Reset view" title="Reset view"><RotateCcw size={14} /></button>
        <span className="stage-control-divider" />
        <button type="button" className="stage-control-button" onClick={() => void host.current?.requestFullscreen?.()} aria-label="Fullscreen viewer" title="Fullscreen"><Maximize2 size={14} /></button>
      </div>}
      {!viewerUnavailable && <p className="stage-footnote">DRAG TO ORBIT <span>·</span> SCROLL TO ZOOM <span>·</span> RIGHT-DRAG TO PAN</p>}
    </div>
  );
}
