import { Injectable } from '@angular/core';
import {
    AmbientLight,
    AudioListener,
    AudioSource,
    BoxCollider,
    Button,
    Camera,
    Canvas,
    CapsuleCollider,
    Component,
    DirectionalLight,
    LineRenderer,
    MeshFilter,
    MeshRenderer,
    ParticleSystem,
    PointLight,
    RectTransform,
    Rigidbody,
    SphereCollider,
    SpotLight,
    SpriteRenderer,
    TypeRegistry,
    UIImage,
    UIText,
    VirtualJoystick,
} from 'WebEngineTS';

/** A Component class that the editor can attach to a GameObject. */
export interface AttachableComponent {
    name: string;
    category: string;
    ctor: new (...args: any[]) => unknown;
}

/**
 * Catalog of components that the editor's "Add Component" picker exposes.
 *
 * @remarks
 * Built-in engine components are listed explicitly here (with display
 * categories) because they aren't decorated with `@Serializable`. User
 * scripts that ARE decorated also show up automatically via {@link TypeRegistry}.
 */
@Injectable({ providedIn: 'root' })
export class ComponentRegistryService {

    /** Curated list of engine builtins — keep alphabetised within each category. */
    private static readonly BUILTINS: AttachableComponent[] = [
        // Rendering
        { name: 'Camera',          category: 'Rendering', ctor: Camera },
        { name: 'MeshFilter',      category: 'Rendering', ctor: MeshFilter },
        { name: 'MeshRenderer',    category: 'Rendering', ctor: MeshRenderer },
        { name: 'LineRenderer',    category: 'Rendering', ctor: LineRenderer },
        { name: 'SpriteRenderer',  category: 'Rendering', ctor: SpriteRenderer },

        // Lights
        { name: 'DirectionalLight', category: 'Lighting', ctor: DirectionalLight },
        { name: 'PointLight',       category: 'Lighting', ctor: PointLight },
        { name: 'SpotLight',        category: 'Lighting', ctor: SpotLight },
        { name: 'AmbientLight',     category: 'Lighting', ctor: AmbientLight },

        // Physics
        { name: 'Rigidbody',       category: 'Physics', ctor: Rigidbody },
        { name: 'BoxCollider',     category: 'Physics', ctor: BoxCollider },
        { name: 'SphereCollider',  category: 'Physics', ctor: SphereCollider },
        { name: 'CapsuleCollider', category: 'Physics', ctor: CapsuleCollider },

        // Audio
        { name: 'AudioSource',   category: 'Audio', ctor: AudioSource },
        { name: 'AudioListener', category: 'Audio', ctor: AudioListener },

        // Particles
        { name: 'ParticleSystem', category: 'Effects', ctor: ParticleSystem },

        // UI
        { name: 'Canvas',          category: 'UI', ctor: Canvas },
        { name: 'RectTransform',   category: 'UI', ctor: RectTransform },
        { name: 'UIImage',         category: 'UI', ctor: UIImage },
        { name: 'UIText',          category: 'UI', ctor: UIText },
        { name: 'Button',          category: 'UI', ctor: Button },
        { name: 'VirtualJoystick', category: 'UI', ctor: VirtualJoystick },
    ];

    /** Lists every component the picker can attach: builtins + user-decorated. */
    public all(): AttachableComponent[] {
        const seen = new Set<string>();
        const out: AttachableComponent[] = [];

        for (const b of ComponentRegistryService.BUILTINS) {
            seen.add(b.name);
            out.push(b);
        }

        // User scripts marked with @Serializable, that descend from Component.
        for (const name of TypeRegistry.all) {
            if (seen.has(name)) continue;
            const ctor = TypeRegistry.get(name);
            if (!ctor || !ComponentRegistryService._isComponentClass(ctor)) continue;
            out.push({ name, category: 'Scripts', ctor: ctor as new (...args: any[]) => unknown });
        }

        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }

    private static _isComponentClass(ctor: Function): boolean {
        let cur: Function | null = ctor;
        while (cur && cur !== Object) {
            if (cur === Component) return true;
            cur = Object.getPrototypeOf(cur) as Function | null;
        }
        return false;
    }
}
