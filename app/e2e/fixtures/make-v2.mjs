// Generates the version-2 scene fixture the e2e "scene formats" scenario opens:
// a link-mode prefab instance, saved exactly as the editor's own engine saves
// one (SceneSerializer.serializeScene with prefabs:"link") - a prefab link is
// what makes the file version 2, so before A8 the editor could not reopen a
// file it had itself written. No custom component types: the editor's registry
// must resolve every component of a fixture it loads. Regenerate with:
//   node app/e2e/fixtures/make-v2.mjs
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetDatabase, GameObject, SceneManager, SceneSerializer, Prefab } from "WebEngineTS";

const HERE = dirname(fileURLToPath(import.meta.url));
const scene = SceneManager.activeScene;
scene.name = "V2Linked";

const source = new GameObject("Holder");
const child = new GameObject("Child");
child.transform.setParent(source.transform, false);
const prefab = Prefab.fromGameObject(source);
source.destroyImmediate();
// A bound guid is what makes the instance write as a link; unbound prefabs
// serialize expanded (version 1), which would not pin the reader upgrade.
AssetDatabase._bindGuid("fixture-holder-0001", prefab);

const instance = prefab.instantiate();
instance.name = "FromV2";

const json = SceneSerializer.serializeScene(scene, { prefabs: "link" });
if (json.version !== 2) throw new Error(`expected a version-2 file, got ${json.version}`);
writeFileSync(resolve(HERE, "v2-linked.json"), JSON.stringify(json, null, 1) + "\n");
console.log("version:", json.version, "roots:", json.roots.length, "->", resolve(HERE, "v2-linked.json"));
