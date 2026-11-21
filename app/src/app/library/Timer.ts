/** Library behaviour source — see Rotator.ts for why it is a string. */
export const TIMER_SOURCE = `import { FieldType, ScriptableBehaviour, Serializable, SerializedField, Time } from "WebEngineTS";

/** Counts down; logs the message when time is up. Repeats or disables itself. */
@Serializable({ typeName: "Timer" })
export default class Timer extends ScriptableBehaviour {
    @SerializedField() public duration = 5;
    @SerializedField() public repeat = false;
    @SerializedField({ type: FieldType.String }) public message = "Time is up";

    private elapsed = 0;

    public override update(): void {
        this.elapsed += Time.deltaTime;
        if (this.elapsed < this.duration) return;
        console.log(this.message);
        if (this.repeat) this.elapsed = 0;
        else this.enabled = false;
    }
}
`;
