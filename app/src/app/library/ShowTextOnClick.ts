/** Library behaviour source — see Rotator.ts for why it is a string. */
export const SHOW_TEXT_ON_CLICK_SOURCE = `import { Camera, FieldType, Input, Physics, RaycastHit, ScriptableBehaviour, Serializable, SerializedField, UIText } from "WebEngineTS";

/**
 * On click, writes the message into a UIText on the same object (or logs it
 * when there is none). Needs a Collider and a Camera tagged MainCamera.
 */
@Serializable({ typeName: "ShowTextOnClick" })
export default class ShowTextOnClick extends ScriptableBehaviour {
    @SerializedField({ type: FieldType.String }) public message = "Hello!";

    public override update(): void {
        if (!Input.getMouseButtonDown(0)) return;
        const camera = Camera.main;
        if (!camera) return;
        const ray = camera.screenPointToRay(Input.mousePosition);
        const hit = new RaycastHit();
        if (Physics.raycast(ray, hit) && hit.gameObject === this.gameObject) {
            const label = this.getComponent(UIText);
            if (label) label.text = this.message;
            else console.log(this.message);
        }
    }
}
`;
