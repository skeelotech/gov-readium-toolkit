import type { Decoration, DecorationStyle, BuiltinDecorationStyle, HTMLDecorationTemplate } from "@readium/navigator-html-injectables";
import { DecorationStyleType } from "@readium/navigator-html-injectables";

export type { Decoration, DecorationStyle, BuiltinDecorationStyle, HTMLDecorationTemplate };
export { DecorationLayout, DecorationStyleType, DecorationWidth } from "@readium/navigator-html-injectables";

export interface DecorationActivationEvent {
    decoration: Decoration;
    group: string;
    /** Bounding rect of the activated decoration in navigator container coordinates (CSS pixels). */
    rect?: { top: number; left: number; width: number; height: number };
    /** Tap/click point in navigator container coordinates (CSS pixels). */
    point?: { x: number; y: number };
}

export interface DecorationObserver {
    /**
     * Called when a user activates a decoration (click or tap).
     * Return true to indicate the event was handled — this suppresses normal tap/click navigation.
     */
    onDecorationActivated(event: DecorationActivationEvent): boolean;
}

function stylesEqual(a: DecorationStyle, b: DecorationStyle): boolean {
    if (a.type !== b.type) return false;
    if ((a.isActive ?? false) !== (b.isActive ?? false)) return false;
    if (a.type === DecorationStyleType.Template) {
        const ta = a as HTMLDecorationTemplate;
        const tb = b as HTMLDecorationTemplate;
        return ta.layout === tb.layout &&
            ta.width === tb.width &&
            ta.element === tb.element &&
            ta.stylesheet === tb.stylesheet;
    }
    const ba = a as BuiltinDecorationStyle;
    const bb = b as BuiltinDecorationStyle;
    return ba.tint === bb.tint &&
        ba.layout === bb.layout &&
        ba.width === bb.width;
}

export function decorationsEqual(a: Decoration, b: Decoration): boolean {
    return (
        a.locator.href === b.locator.href &&
        JSON.stringify(a.locator.locations?.serialize()) === JSON.stringify(b.locator.locations?.serialize()) &&
        stylesEqual(a.style, b.style) &&
        JSON.stringify(a.extras ?? null) === JSON.stringify(b.extras ?? null)
    );
}

export interface DecorableNavigator {
    /**
     * Replaces all decorations for the given group with the provided list.
     * The navigator diffs the new list against the current state and issues
     * add / update / remove / clear commands as needed.
     */
    applyDecorations(decorations: Decoration[], group: string): void;

    /**
     * Returns whether the given style can be rendered by this navigator.
     * Always returns true for HTML-based navigators.
     */
    supportsDecorationStyle(style: DecorationStyle): boolean;

    /** Registers an observer for activation events on the given group. */
    registerDecorationObserver(group: string, observer: DecorationObserver): void;

    /** Unregisters a previously registered observer from all groups. */
    unregisterDecorationObserver(observer: DecorationObserver): void;
}
