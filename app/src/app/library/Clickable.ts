/** Library behaviour source — see Rotator.ts for why it is a string. */
export const CLICKABLE_SOURCE = `import { Camera, FieldType, Input, Physics, RaycastHit, ScriptableBehaviour, Serializable, SerializedField } from "WebEngineTS";

/**
 * Logs a message when the object is clicked. Needs a Collider on the object
 * and a Camera tagged MainCamera — the ray goes through the pointer.
 */
@Serializable({ typeName: "Clickable" })
export default class Clickable extends ScriptableBehaviour {
    @SerializedField({ type: FieldType.String }) public message = "clicked";

    public override update(): void {
        if (!Input.getMouseButtonDown(0)) return;
        const camera = Camera.main;
        if (!camera) return;
        const ray = camera.screenPointToRay(Input.mousePosition);
        const hit = new RaycastHit();
        if (Physics.raycast(ray, hit) && hit.gameObject === this.gameObject) {
            console.log(this.message);
        }
    }
}
`;
