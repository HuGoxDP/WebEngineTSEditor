/** Library behaviour source — see Rotator.ts for why it is a string. */
export const LOOK_AT_CAMERA_SOURCE = `import { Camera, ScriptableBehaviour, Serializable, SerializedField } from "WebEngineTS";

/** Billboards the object towards the main camera every frame. */
@Serializable({ typeName: "LookAtCamera" })
export default class LookAtCamera extends ScriptableBehaviour {
    @SerializedField({ displayName: "Face away" }) public faceAway = false;

    public override update(): void {
        const camera = Camera.main;
        if (!camera) return;
        const target = camera.transform.position;
        if (!this.faceAway) {
            this.transform.lookAt(target);
            return;
        }
        const position = this.transform.position;
        this.transform.lookAt(position.clone().multiplyScalar(2).subtract(target));
    }
}
`;
