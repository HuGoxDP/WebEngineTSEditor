/**
 * Library behaviour source (C4 phase 4, D5). The string is what "Add component
 * → Library" copies into the project as `scripts/library/Rotator.ts`; it is
 * compiled by the editor's Babel runtime and by ScenarioCreator's strict tsc,
 * so it must satisfy both (public overrides, explicit field types).
 */
export const ROTATOR_SOURCE = `import { FieldType, ScriptableBehaviour, Serializable, SerializedField, Time, Vector3 } from "WebEngineTS";

/** Spins the object around its own axis, in degrees per second. */
@Serializable({ typeName: "Rotator" })
export default class Rotator extends ScriptableBehaviour {
    @SerializedField() public speed = 90;
    @SerializedField({ type: FieldType.Vector3 }) public axis = new Vector3(0, 1, 0);

    public override update(): void {
        const step = this.speed * Time.deltaTime;
        this.transform.rotate(new Vector3(this.axis.x * step, this.axis.y * step, this.axis.z * step));
    }
}
`;
