/** Library behaviour source — see Rotator.ts for why it is a string. */
export const QUIZ_QUESTION_SOURCE = `import { Camera, FieldType, Input, Physics, RaycastHit, ScriptableBehaviour, Serializable, SerializedField, UIText } from "WebEngineTS";

/**
 * Click the object to flip a UIText between the question and its answer.
 * Needs a Collider, a Camera tagged MainCamera, and a UIText on the object.
 */
@Serializable({ typeName: "QuizQuestion" })
export default class QuizQuestion extends ScriptableBehaviour {
    @SerializedField({ type: FieldType.String }) public question = "What is 2 + 2?";
    @SerializedField({ type: FieldType.String }) public answer = "4";

    private showingAnswer = false;

    public override start(): void {
        const label = this.getComponent(UIText);
        if (label) label.text = this.question;
    }

    public override update(): void {
        if (!Input.getMouseButtonDown(0)) return;
        const camera = Camera.main;
        if (!camera) return;
        const ray = camera.screenPointToRay(Input.mousePosition);
        const hit = new RaycastHit();
        if (Physics.raycast(ray, hit) && hit.gameObject === this.gameObject) {
            this.showingAnswer = !this.showingAnswer;
            const label = this.getComponent(UIText);
            if (label) label.text = this.showingAnswer ? this.answer : this.question;
        }
    }
}
`;
