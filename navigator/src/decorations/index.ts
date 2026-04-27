import type { Decoration, DecorationStyle } from "@readium/navigator-html-injectables";

export type { Decoration, DecorationStyle };
export { DecorationLayout, DecorationWidth } from "@readium/navigator-html-injectables";

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

export function decorationsEqual(a: Decoration, b: Decoration): boolean {
    return (
        a.locator.href === b.locator.href &&
        JSON.stringify(a.locator.locations?.serialize()) === JSON.stringify(b.locator.locations?.serialize()) &&
        a.style.tint === b.style.tint &&
        a.style.layout === b.style.layout &&
        a.style.width === b.style.width &&
        (a.style.isActive ?? false) === (b.style.isActive ?? false) &&
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
