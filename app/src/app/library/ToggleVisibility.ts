/** Library behaviour source — see Rotator.ts for why it is a string. */
export const TOGGLE_VISIBILITY_SOURCE = `import { FieldType, Input, ScriptableBehaviour, Serializable, SerializedField } from "WebEngineTS";

/** Shows or hides the whole object each time the key is pressed. */
@Serializable({ typeName: "ToggleVisibility" })
export default class ToggleVisibility extends ScriptableBehaviour {
    @SerializedField({ type: FieldType.String, displayName: "Toggle key" }) public key = "KeyV";

    public override update(): void {
        if (Input.getKeyDown(this.key)) {
            this.gameObject.setActive(!this.gameObject.activeSelf);
        }
    }
}
`;
