/** Library behaviour source — see Rotator.ts for why it is a string. */
export const FOLLOW_PATH_SOURCE = `import { FieldType, ScriptableBehaviour, Serializable, SerializedField, Time, Vector3 } from "WebEngineTS";

/** Walks the waypoint list at a fixed speed; loops or stops at the end. */
@Serializable({ typeName: "FollowPath" })
export default class FollowPath extends ScriptableBehaviour {
    @SerializedField() public speed = 2;
    @SerializedField() public loop = true;
    @SerializedField({ type: FieldType.Array, elementType: FieldType.Vector3 })
    public waypoints: Vector3[] = [new Vector3(0, 0, 0), new Vector3(3, 0, 0)];

    private index = 0;

    public override update(): void {
        if (this.waypoints.length === 0) return;
        const target = this.waypoints[this.index];
        const position = this.transform.position;
        this.transform.position = Vector3.moveTowards(position, target, this.speed * Time.deltaTime);
        if (Vector3.distance(this.transform.position, target) > 0.001) return;
        if (this.index + 1 < this.waypoints.length) this.index += 1;
        else if (this.loop) this.index = 0;
        else this.enabled = false;
    }
}
`;
