/** Library behaviour source — see Rotator.ts for why it is a string. */
export const TOGGLE_VISIBILITY_SOURCE = `import { FieldType, Input, Renderer, ScriptableBehaviour, Serializable, SerializedField } from "WebEngineTS";

/** Shows or hides this object's (and its children's) renderers on each key press. */
@Serializable({ typeName: "ToggleVisibility" })
export default class ToggleVisibility extends ScriptableBehaviour {
    @SerializedField({ type: FieldType.String, displayName: "Toggle key" }) public key = "KeyV";

    private _hidden = false;

    public override update(): void {
        if (Input.getKeyDown(this.key)) {
            this._hidden = !this._hidden;
            // Keep the object and its children active: the engine does not
            // update inactive objects, so a second press would never arrive.
            for (const renderer of this.gameObject.getComponentsInChildren(Renderer, true)) {
                renderer.enabled = !this._hidden;
            }
        }
    }
}
`;
