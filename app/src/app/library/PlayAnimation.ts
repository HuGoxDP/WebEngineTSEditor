/** Library behaviour source — see Rotator.ts for why it is a string. */
export const PLAY_ANIMATION_SOURCE = `import { Animation, Animator, FieldType, ScriptableBehaviour, Serializable, SerializedField } from "WebEngineTS";

/**
 * Plays a clip on start through whichever animation component is present.
 * Tolerates objects with neither Animation nor Animator (does nothing).
 */
@Serializable({ typeName: "PlayAnimation" })
export default class PlayAnimation extends ScriptableBehaviour {
    @SerializedField({ type: FieldType.String }) public clipName = "Idle";
    @SerializedField({ displayName: "Play on start" }) public playOnStart = true;

    public override start(): void {
        if (this.playOnStart) this.play();
    }

    public play(): void {
        const animation = this.getComponent(Animation);
        if (animation) {
            animation.play(this.clipName);
            return;
        }
        const animator = this.getComponent(Animator);
        if (animator) animator.play(this.clipName);
    }
}
`;
