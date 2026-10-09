/**
 * What a new project is made of: its identity file, its entry point, and the
 * rules for turning a title typed by a person into a folder name and an id.
 */

/** The platform's categories — `ScenarioCategory` in the engine. The school subject is a separate field, entered at upload. */
export type ProjectCategory = 'education' | 'demo' | 'interactive' | 'simulation';

export const PROJECT_CATEGORIES: readonly ProjectCategory[] = ['education', 'demo', 'interactive', 'simulation'];

/** What the first scene of a new project holds. */
export type TemplateId = 'empty' | 'lightCamera';

/** What goes into `scenario.meta.json`. Fields nobody stated are left out, never invented. */
export interface ProjectMeta {
    /** The catalog slug, and the address `/play/<id>`. */
    id: string;
    name: string;
    description?: string;
    category?: ProjectCategory;
    version: string;
}

/** An id the platform and ScenarioCreator both take: lowercase letters and digits, hyphen-separated. */
export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Characters a file name may not contain on Windows, the strictest of the platforms people use. */
const FORBIDDEN_IN_NAME = /[\\/:*?"<>|]+/g;

/**
 * Ukrainian (and the Russian letters it lacks) to Latin, after the 2010
 * national transliteration, simplified: no apostrophes, so the result is a valid id.
 */
const TRANSLITERATION: Readonly<Record<string, string>> = {
    а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z',
    и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
    р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
    щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ъ: '', ё: 'io',
};

/**
 * A catalog id from a title: «Будова атома» → `budova-atoma`.
 * Falls back to `scenario` when nothing usable is left (a title of symbols only).
 */
export function slugify(title: string): string {
    const latin = [...title.toLowerCase()].map(ch => TRANSLITERATION[ch] ?? ch).join('');
    const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'scenario';
}

/**
 * A folder name from a title. Keeps the person's own letters — a folder called
 * «Будова атома» is what they will look for — and drops only what the file
 * system refuses.
 */
export function folderNameFor(title: string): string {
    const name = title.replace(FORBIDDEN_IN_NAME, '-').trim().replace(/[. ]+$/, '').slice(0, 60);
    return name || 'Scenario';
}

/** Whether `name` can be a folder name. Returns an empty string if it can, otherwise why not (as a reason key). */
export function folderNameProblem(name: string): 'empty' | 'characters' | '' {
    if (name.trim() === '') return 'empty';
    if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name)) return 'characters';
    return '';
}

/** The text of `scenario.meta.json`. */
export function metaJson(meta: ProjectMeta): string {
    const out: Record<string, unknown> = { id: meta.id, name: meta.name };
    if (meta.description?.trim()) out['description'] = meta.description.trim();
    if (meta.category) out['category'] = meta.category;
    out['version'] = meta.version;
    return `${JSON.stringify(out, null, 2)}\n`;
}

/** Identity for a folder that was not set up through the wizard: derived from its name, nothing more. */
export function defaultMeta(folderName: string): ProjectMeta {
    return { id: slugify(folderName), name: folderName, version: '1.0.0' };
}

/**
 * Entry point written into a new project. It loads the scene the editor saved;
 * anything better built in code goes after that call.
 */
export const SCENARIO_TEMPLATE = `import { ScenarioBehaviour, SceneSerializer } from "WebEngineTS";

/** Scene the editor saves, relative to assets/. */
const SCENE = "scenes/main.scene.json";

export default class Scenario extends ScenarioBehaviour {

    override async awake(): Promise<void> {
        const blob = await this.context.assets.getAsset(SCENE);
        SceneSerializer.deserializeScene(JSON.parse(await blob.text()));
    }
}
`;
