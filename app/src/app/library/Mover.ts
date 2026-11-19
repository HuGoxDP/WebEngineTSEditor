/** Library behaviour source — see Rotator.ts for why it is a string. */
export const MOVER_SOURCE = `import { FieldType, ScriptableBehaviour, Serializable, SerializedField, Space, Time, Vector3 } from "WebEngineTS";

/** Moves the object along a world-space direction, in units per second. */
@Serializable({ typeName: "Mover" })
export default class Mover extends ScriptableBehaviour {
    @SerializedField() public speed = 1;
    @SerializedField({ type: FieldType.Vector3 }) public direction = new Vector3(1, 0, 0);

    public override update(): void {
        const step = this.speed * Time.deltaTime;
        this.transform.translate(
            new Vector3(this.direction.x * step, this.direction.y * step, this.direction.z * step),
            Space.World,
        );
    }
}
`;
