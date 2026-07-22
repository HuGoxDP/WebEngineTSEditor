/* Scene, hierarchy, and components data model */

const EULER = (q) => q; // ids kept as euler degrees directly for simplicity

// Initial scene data
const INITIAL_SCENE = {
  name: "MainScene",
  dirty: true,
  nodes: [
    {
      id: "n1", name: "Main Camera", kind: "camera", active: true, expanded: true, parent: null,
      components: ["transform", "camera", "script:CameraRig"],
      state: {
        transform: { pos: [0, 2.5, -8], rot: [10, 0, 0], scl: [1, 1, 1] },
        camera: { fov: 60, near: 0.3, far: 1000, clearColor: "#1b2238", projection: 0, hdr: false },
        "script:CameraRig": { target: null, smoothTime: 0.2, lookAhead: 1.4, enabled: true },
      },
    },
    {
      id: "n2", name: "Directional Light", kind: "light", active: true, expanded: true, parent: null,
      components: ["transform", "light"],
      state: {
        transform: { pos: [0, 6, 0], rot: [55, -25, 0], scl: [1, 1, 1] },
        light: { type: 1, color: "#fff0d6", intensity: 1.2, range: 10, shadows: true },
      },
    },
    {
      id: "n3", name: "Player", kind: "player", active: true, expanded: true, parent: null,
      components: ["transform", "mesh", "rigidbody", "collider", "script:PlayerController"],
      state: {
        transform: { pos: [0, 1, 0], rot: [0, 0, 0], scl: [1, 1, 1] },
        mesh: { mesh: "Capsule.mesh", material: "PlayerMat", color: "#ff9f2a", castShadows: true, recvShadows: true },
        rigidbody: { mass: 1.0, drag: 0.2, angularDrag: 0.05, useGravity: true, isKinematic: false },
        collider: { size: [0.6, 1.8, 0.6], center: [0, 0.9, 0], isTrigger: false, material: "DefaultPhysics" },
        "script:PlayerController": { moveSpeed: 6.5, jumpHeight: 1.8, gravityMultiplier: 2.5, enabled: true },
      },
    },
    { id: "n3a", name: "Body", kind: "cube", active: true, expanded: false, parent: "n3",
      components: ["transform", "mesh"],
      state: {
        transform: { pos: [0, 0.9, 0], rot: [0, 0, 0], scl: [0.6, 1.8, 0.6] },
        mesh: { mesh: "Cube.mesh", material: "PlayerMat", color: "#ff9f2a", castShadows: true, recvShadows: true },
      },
    },
    {
      id: "n4", name: "Environment", kind: "group", active: true, expanded: true, parent: null,
      components: ["transform"],
      state: { transform: { pos: [0, 0, 0], rot: [0, 0, 0], scl: [1, 1, 1] } },
    },
    {
      id: "n4a", name: "Ground", kind: "cube", active: true, expanded: false, parent: "n4",
      components: ["transform", "mesh", "collider"],
      state: {
        transform: { pos: [0, 0, 0], rot: [0, 0, 0], scl: [20, 0.2, 20] },
        mesh: { mesh: "Plane.mesh", material: "Concrete", color: "#3a3d46", castShadows: false, recvShadows: true },
        collider: { size: [20, 0.2, 20], center: [0, 0, 0], isTrigger: false, material: "DefaultPhysics" },
      },
    },
    {
      id: "n4b", name: "Crate.A", kind: "cube", active: true, expanded: false, parent: "n4",
      components: ["transform", "mesh", "collider", "rigidbody"],
      state: {
        transform: { pos: [-2, 0.5, 1.5], rot: [0, 24, 0], scl: [1, 1, 1] },
        mesh: { mesh: "Cube.mesh", material: "Wood", color: "#a07040", castShadows: true, recvShadows: true },
        collider: { size: [1, 1, 1], center: [0, 0, 0], isTrigger: false, material: "DefaultPhysics" },
        rigidbody: { mass: 2.0, drag: 0.1, angularDrag: 0.05, useGravity: true, isKinematic: false },
      },
    },
    {
      id: "n4c", name: "Crate.B", kind: "cube", active: true, expanded: false, parent: "n4",
      components: ["transform", "mesh", "collider"],
      state: {
        transform: { pos: [2.4, 0.5, 0.6], rot: [0, -12, 0], scl: [1, 1, 1] },
        mesh: { mesh: "Cube.mesh", material: "Wood", color: "#8c6035", castShadows: true, recvShadows: true },
        collider: { size: [1, 1, 1], center: [0, 0, 0], isTrigger: false, material: "DefaultPhysics" },
      },
    },
    {
      id: "n4d", name: "Crate.C", kind: "cube", active: true, expanded: false, parent: "n4",
      components: ["transform", "mesh", "collider"],
      state: {
        transform: { pos: [1, 1.6, 1.2], rot: [12, 34, 6], scl: [1, 1, 1] },
        mesh: { mesh: "Cube.mesh", material: "Wood", color: "#96693a", castShadows: true, recvShadows: true },
        collider: { size: [1, 1, 1], center: [0, 0, 0], isTrigger: false, material: "DefaultPhysics" },
      },
    },
    {
      id: "n5", name: "Trigger.Checkpoint", kind: "trigger", active: true, expanded: false, parent: null,
      components: ["transform", "collider"],
      state: {
        transform: { pos: [5, 0.8, 2], rot: [0, 0, 0], scl: [1, 1, 1] },
        collider: { size: [2, 2, 2], center: [0, 0, 0], isTrigger: true, material: "" },
      },
    },
    {
      id: "n6", name: "EventSystem", kind: "group", active: false, expanded: false, parent: null,
      components: ["transform"],
      state: { transform: { pos: [0, 0, 0], rot: [0, 0, 0], scl: [1, 1, 1] } },
    },
  ],
};

// Component type catalog — Inspector schema
const COMPONENT_CATALOG = {
  transform: {
    title: "Transform",
    icon: "Move",
    removable: false,
    fields: [
      { key: "pos", label: "Position", type: "vec3", step: 0.1 },
      { key: "rot", label: "Rotation", type: "vec3", step: 1, unit: "°" },
      { key: "scl", label: "Scale",    type: "vec3", step: 0.1 },
    ],
  },
  mesh: {
    title: "Mesh Renderer",
    icon: "Mesh",
    fields: [
      { key: "mesh",        label: "Mesh",          type: "asset", assetType: "mesh" },
      { key: "material",    label: "Material",      type: "asset", assetType: "material" },
      { key: "color",       label: "Albedo",        type: "color" },
      { key: "castShadows", label: "Cast Shadows",  type: "bool" },
      { key: "recvShadows", label: "Receive Shadows", type: "bool" },
    ],
  },
  rigidbody: {
    title: "Rigidbody",
    icon: "Rigid",
    fields: [
      { key: "mass",         label: "Mass",          type: "number", min: 0, step: 0.1 },
      { key: "drag",         label: "Drag",          type: "number", min: 0, step: 0.01 },
      { key: "angularDrag",  label: "Angular Drag",  type: "number", min: 0, step: 0.01 },
      { key: "useGravity",   label: "Use Gravity",   type: "bool" },
      { key: "isKinematic",  label: "Is Kinematic",  type: "bool" },
    ],
  },
  collider: {
    title: "Box Collider",
    icon: "Collider",
    fields: [
      { key: "size",      label: "Size",       type: "vec3", step: 0.1 },
      { key: "center",    label: "Center",     type: "vec3", step: 0.1 },
      { key: "isTrigger", label: "Is Trigger", type: "bool" },
      { key: "material",  label: "Phys Mat",   type: "asset", assetType: "physicsMaterial" },
    ],
  },
  camera: {
    title: "Camera",
    icon: "Camera",
    fields: [
      { key: "fov",        label: "Field of View", type: "range", min: 1, max: 179, step: 1 },
      { key: "near",       label: "Near Clip",     type: "number", min: 0.01, step: 0.01 },
      { key: "far",        label: "Far Clip",      type: "number", min: 1, step: 1 },
      { key: "clearColor", label: "Clear Color",   type: "color" },
      { key: "projection", label: "Projection",    type: "enum", options: ["Perspective", "Orthographic"] },
      { key: "hdr",        label: "HDR",           type: "bool" },
    ],
  },
  light: {
    title: "Light",
    icon: "Light",
    fields: [
      { key: "type",      label: "Type",      type: "enum", options: ["Point", "Directional", "Spot", "Area"] },
      { key: "color",     label: "Color",     type: "color" },
      { key: "intensity", label: "Intensity", type: "range", min: 0, max: 8, step: 0.05 },
      { key: "range",     label: "Range",     type: "number", min: 0, step: 0.1 },
      { key: "shadows",   label: "Shadows",   type: "bool" },
    ],
  },
  "script:PlayerController": {
    title: "PlayerController (Script)",
    icon: "Script",
    scripted: true,
    fields: [
      { key: "moveSpeed",         label: "Move Speed",   type: "range", min: 0, max: 20, step: 0.1 },
      { key: "jumpHeight",        label: "Jump Height",  type: "number", min: 0, step: 0.1 },
      { key: "gravityMultiplier", label: "Gravity Mult", type: "number", min: 0, step: 0.1 },
      { key: "enabled",           label: "Enabled",      type: "bool" },
    ],
  },
  "script:CameraRig": {
    title: "CameraRig (Script)",
    icon: "Script",
    scripted: true,
    fields: [
      { key: "target",     label: "Target",     type: "ref" },
      { key: "smoothTime", label: "Smooth",     type: "number", min: 0, step: 0.01 },
      { key: "lookAhead",  label: "Look Ahead", type: "number", min: 0, step: 0.1 },
      { key: "enabled",    label: "Enabled",    type: "bool" },
    ],
  },
};

// Folder / assets data
const FOLDERS = [
  { id: "Assets", label: "Assets", level: 0, expanded: true },
  { id: "Assets/Scenes", label: "Scenes", level: 1 },
  { id: "Assets/Scripts", label: "Scripts", level: 1 },
  { id: "Assets/Materials", label: "Materials", level: 1 },
  { id: "Assets/Meshes", label: "Meshes", level: 1 },
  { id: "Assets/Textures", label: "Textures", level: 1 },
  { id: "Assets/Prefabs", label: "Prefabs", level: 1 },
  { id: "Assets/Audio", label: "Audio", level: 1 },
  { id: "Packages", label: "Packages", level: 0 },
];

const ASSETS = {
  "Assets": [
    { name: "Scenes", type: "folder" },
    { name: "Scripts", type: "folder" },
    { name: "Materials", type: "folder" },
    { name: "Meshes", type: "folder" },
    { name: "Textures", type: "folder" },
    { name: "Prefabs", type: "folder" },
    { name: "Audio", type: "folder" },
    { name: "MainScene.scene.json", type: "scene" },
  ],
  "Assets/Scenes": [
    { name: "MainScene", type: "scene" },
    { name: "Menu", type: "scene" },
    { name: "LoadTest", type: "scene" },
  ],
  "Assets/Scripts": [
    { name: "PlayerController.ts", type: "script" },
    { name: "CameraRig.ts", type: "script" },
    { name: "Spawner.ts", type: "script" },
    { name: "GameMode.ts", type: "script" },
    { name: "EnemyAI.ts", type: "script" },
  ],
  "Assets/Materials": [
    { name: "PlayerMat", type: "material", tint: "#ff9f2a" },
    { name: "Concrete", type: "material", tint: "#707076" },
    { name: "Wood", type: "material", tint: "#a07040" },
    { name: "Skybox", type: "material", tint: "#4fa6ff" },
  ],
  "Assets/Meshes": [
    { name: "Cube.mesh", type: "mesh" },
    { name: "Capsule.mesh", type: "mesh" },
    { name: "Plane.mesh", type: "mesh" },
    { name: "Sphere.mesh", type: "mesh" },
  ],
  "Assets/Textures": [
    { name: "grid_512.png", type: "tex" },
    { name: "noise_01.png", type: "tex" },
    { name: "crate_albedo.png", type: "tex" },
  ],
  "Assets/Prefabs": [
    { name: "Player.prefab", type: "prefab" },
    { name: "Crate.prefab", type: "prefab" },
    { name: "Checkpoint.prefab", type: "prefab" },
  ],
  "Assets/Audio": [
    { name: "footstep_01.wav", type: "audio" },
    { name: "jump.wav", type: "audio" },
    { name: "ambient_loop.ogg", type: "audio" },
  ],
};

const INITIAL_LOGS = [
  { lvl: "info", t: "11:29:42", src: "Engine.Boot",   msg: "WebEngineTS 0.1.0 (build 2024.04) initialized in 312ms", pin: 1 },
  { lvl: "info", t: "11:29:42", src: "Renderer.Three", msg: "WebGL2 context · GPU: ANGLE (Apple M2, OpenGL ES 3.0) · max texture 16384px", pin: 1 },
  { lvl: "info", t: "11:29:42", src: "Physics.Cannon", msg: "Physics world created (gravity = 0, -9.81, 0 · fixed Δt 0.0166s)", pin: 1 },
  { lvl: "info", t: "11:29:42", src: "Assets.Loader",  msg: "Loaded 4 meshes, 4 materials, 3 textures from Assets/", pin: 1 },
  { lvl: "info", t: "11:29:42", src: "Scene.Loader",   msg: "Opened scene 'MainScene' · 7 GameObjects · 4 colliders", pin: 1 },
  { lvl: "warn", t: "11:29:43", src: "MeshRenderer",   msg: "Player/Body: material 'PlayerMat' has no normal map assigned — falling back to default", pin: 1 },
  { lvl: "warn", t: "11:29:43", src: "Script.Compiler",msg: "EnemyAI.ts: parameter 'patrolRadius' declared but never used (ts6133)", pin: 1 },
  { lvl: "info", t: "11:29:58", src: "User",           msg: "Selected GameObject 'Player' (instanceID 0x1a32)", pin: 1 },
];

const INITIAL_TIMELINE = {
  playhead: 1.2,
  duration: 8.0,
  tracks: [
    { name: "Player / Transform", kind: "anim", color: "amber", clips: [{ start: 0, end: 3.2 }], keys: [0, 0.4, 1.0, 1.6, 2.2, 2.8] },
    { name: "Player / PlayerController.moveSpeed", kind: "anim", color: "amber", keys: [0, 1.5, 3.0, 4.5, 6.0] },
    { name: "Camera / FOV", kind: "anim", color: "blue", clips: [{ start: 0.4, end: 2.6 }], keys: [0.4, 1.2, 2.6] },
    { name: "Light / Intensity", kind: "anim", color: "blue", keys: [0, 1.0, 2.0, 3.0] },
    { name: "Audio / ambient_loop", kind: "audio", color: "green", clips: [{ start: 0, end: 7.8 }] },
    { name: "Event / OnSpawn", kind: "event", color: "violet", keys: [0.1] },
    { name: "Event / OnCheckpoint", kind: "event", color: "violet", keys: [4.2, 6.1] },
  ],
};

// Fake TS script for Code tab
const FAKE_SCRIPTS = {
  "PlayerController.ts":
`import { Behaviour, Serializable, Field, Range, Vector3, Input, KeyCode } from "WebEngineTS";
import { Rigidbody } from "WebEngineTS/physics";

@Serializable("PlayerController")
export class PlayerController extends Behaviour {

    @Field @Range(0, 20)
    public moveSpeed: number = 6.5;

    @Field
    public jumpHeight: number = 1.8;

    @Field
    public gravityMultiplier: number = 2.5;

    private _rb!: Rigidbody;
    private _grounded: boolean = false;

    public awake(): void {
        this._rb = this.getComponent(Rigidbody)!;
    }

    public update(): void {
        const h = Input.getAxis("Horizontal");
        const v = Input.getAxis("Vertical");
        const move = new Vector3(h, 0, v).normalized.multiplyScalar(this.moveSpeed);
        this._rb.velocity = new Vector3(move.x, this._rb.velocity.y, move.z);

        if (Input.getKeyDown(KeyCode.Space) && this._grounded) {
            const vy = Math.sqrt(2 * 9.81 * this.gravityMultiplier * this.jumpHeight);
            this._rb.velocity = new Vector3(move.x, vy, move.z);
            this._grounded = false;
        }
    }

    public onCollisionStay(): void {
        this._grounded = true;
    }
}`,
  "CameraRig.ts":
`import { Behaviour, Serializable, Field, GameObject, Vector3 } from "WebEngineTS";

@Serializable("CameraRig")
export class CameraRig extends Behaviour {

    @Field public target: GameObject | null = null;
    @Field public smoothTime: number = 0.2;
    @Field public lookAhead: number  = 1.4;

    private _vel: Vector3 = new Vector3();

    public lateUpdate(): void {
        if (!this.target) return;
        const goal = this.target.transform.position
            .add(new Vector3(0, 2.5, -this.lookAhead * 4));
        this.transform.position =
            Vector3.smoothDamp(this.transform.position, goal, this._vel, this.smoothTime);
        this.transform.lookAt(this.target.transform.position);
    }
}`,
  "Spawner.ts":
`import { Behaviour, Serializable, Field, GameObject } from "WebEngineTS";

@Serializable("Spawner")
export class Spawner extends Behaviour {
    @Field public prefab: GameObject | null = null;
    @Field public interval: number = 2.0;
    private _t: number = 0;

    public update(): void {
        this._t += this.time.deltaTime;
        if (this._t >= this.interval) { this._t = 0; /* instantiate */ }
    }
}`,
  "GameMode.ts":
`import { Behaviour, Serializable, Field } from "WebEngineTS";

@Serializable("GameMode")
export class GameMode extends Behaviour {
    @Field public score: number = 0;
    @Field public lives: number = 3;

    public start(): void {
        console.log("[GameMode] ready");
    }
}`,
  "EnemyAI.ts":
`import { Behaviour, Serializable, Field } from "WebEngineTS";

@Serializable("EnemyAI")
export class EnemyAI extends Behaviour {
    @Field public patrolRadius: number = 5;
    @Field public sightRange: number = 8;
    @Field public attackCooldown: number = 1.2;
}`,
};

window.WETS_DATA = { INITIAL_SCENE, COMPONENT_CATALOG, FOLDERS, ASSETS, INITIAL_LOGS, INITIAL_TIMELINE, FAKE_SCRIPTS };
