import { Locator } from "@readium/shared";
import { Comms } from "../comms/comms.ts";
import { Module } from "./Module.ts";
import { rangeFromLocator } from "../helpers/locator.ts";
import { ModuleName } from "./ModuleLibrary.ts";
import { Rect, getClientRectsNoOverlap, rectContainsPoint } from "../helpers/rect.ts";
import { getProperty } from "../helpers/css.ts";
import { ReadiumWindow } from "../helpers/dom.ts";
import { isDarkColor, getContrastingTextColor } from "../helpers/color.ts";

const DEFAULT_HIGHLIGHT_COLOR = "#FFFF00"; // Yellow in HEX

export enum DecorationWidth {
    Wrap = "wrap", // Smallest width fitting the CSS border box.
    Viewport = "viewport", // Fills the whole viewport.
    Bounds = "bounds", // Fills the anchor page, useful for dual page.
    Page = "page", // Fills the whole viewport.
}

export enum DecorationLayout {
    Boxes = "boxes", // One HTML element for each CSS border box (e.g. line of text).
    Bounds = "bounds", // A single HTML element covering the smallest region containing all CSS border boxes.
}

// TODO improve
export interface DecorationStyle {
    tint: string; // CSS color string
    layout: DecorationLayout; // Determines the number of created HTML elements and their position relative to the matching DOM range.
    width: DecorationWidth; // Indicates how the width of each created HTML element expands in the viewport.
    isActive?: boolean; // Whether user activation (click/tap) events fire for this decoration.
}

export interface Decoration {
    id: string; // Unique ID of the decoration. It must be unique in the group the decoration is applied to.
    locator: Locator; // Location in the publication where the decoration will be rendered.
    style: DecorationStyle; // Declares the look and feel of the decoration.
    extras?: Record<string, unknown>; // App-specific context data passed through to DecorationActivationEvent.
}

export interface DecorationActivatedEvent {
    decorationId: string;
    group: string; // Human-readable group name (matches DecoratorRequest.group).
    rect: { top: number; left: number; width: number; height: number }; // Bounding rect in iframe client coords.
    point: { x: number; y: number }; // Click point in iframe client coords.
}

export type DecoratorRequest =
    | { group: string; action: "add" | "update"; decoration: Decoration }
    | { group: string; action: "remove"; decoration: Pick<Decoration, "id"> }
    | { group: string; action: "clear" };

interface DecorationItem {
    id: string;
    decoration: Decoration;
    range: Range;

    clickableElements: HTMLElement[] | undefined;
    container: HTMLElement | undefined;
}

const canNativeHighlight = () => ("Highlight" in window);
const cannotNativeHighlight = ["IMG", "IMAGE", "AUDIO", "VIDEO", "SVG"];

class DecorationGroup {
    public readonly items: DecorationItem[] = [];
    private lastItemId = 0;
    private container: HTMLDivElement | undefined = undefined;
    private _activatable = false;
    public readonly experimentalHighlights: boolean = false;
    private readonly notTextFlag: Map<string, boolean> | undefined;
    private readonly activationHandler: (e: PointerEvent) => void;

    /**
     * Creates a DecorationGroup object
     * @param id Unique HTML ID-adhering name of the group
     * @param name Human-readable name of the group
     */
    constructor(
        private readonly wnd: ReadiumWindow,
        private readonly comms: Comms,
        private readonly id: string,
        private readonly name: string
    ) {
        if (canNativeHighlight()) {
            this.experimentalHighlights = true;
            this.notTextFlag = new Map<string, boolean>();
        }
        this.activationHandler = this.handleActivation.bind(this);
        this.wnd.document.addEventListener("pointerup", this.activationHandler);
    }

    get activatable() {
        return this._activatable;
    }

    set activatable(value: boolean) {
        this._activatable = value;
    }

    /**
     * Adds a new decoration to the group.
     * @param decoration Decoration to add
     */
    add(decoration: Decoration) {
        const id = `${this.id}-${this.lastItemId++}`;

        const range = rangeFromLocator(this.wnd.document, decoration.locator);
        if (!range) {
            this.comms.log("Can't locate DOM range for decoration", decoration);
            return;
        }
        const ancestor = range.commonAncestorContainer as HTMLElement;
        if(ancestor.nodeType !== Node.TEXT_NODE && this.experimentalHighlights) {
            if(cannotNativeHighlight.includes(ancestor.nodeName.toUpperCase())) {
                // The common ancestor is an element that definitely cannot be highlighted
                this.notTextFlag?.set(id, true);
            }
            // Check if the range itself contains elements that cannot be highlighted
            const rangeFragment = range.cloneContents();
            if(rangeFragment.querySelector(cannotNativeHighlight.join(", ").toLowerCase())) {
                // Range contains elements that definitely cannot be highlighted
                this.notTextFlag?.set(id, true);
            }
            if((ancestor.textContent?.trim() || "").length === 0) {
                // No text to be highlighted
                this.notTextFlag?.set(id, true);
            }
        }

        const item = {
            decoration,
            id,
            range,
        } as DecorationItem;

        this.items.push(item);
        this.layout(item);
        this.renderLayout([item]);
    }

    /**
     * Removes the decoration with given ID from the group.
     * @param identifier ID of item to remove
     */
    remove(identifier: string) {
        const index = this.items.findIndex(i => i.decoration.id === identifier);
        if (index < 0) return;

        const item = this.items[index];
        this.items.splice(index, 1);
        item.clickableElements = undefined;
        if (item.container) {
            item.container.remove();
            item.container = undefined;
        }
        if (this.experimentalHighlights && !this.notTextFlag?.has(item.id)) {
            // Remove highlight from ranges
            const mm = ((this.wnd as any).CSS.highlights as Map<string, unknown>).get(this.id) as Set<Range>;
            mm?.delete(item.range);
        }
        this.notTextFlag?.delete(item.id);
    }

    /**
     * Notifies that the given decoration was modified and needs to be updated.
     * @param decoration Decoration to update
     */
    update(decoration: Decoration) {
        this.remove(decoration.id);
        this.add(decoration);
    }

    /**
     * Removes all decorations from this group.
     */
    clear() {
        this.clearContainer();
        this.items.length = 0;
        this.notTextFlag?.clear();
    }

    /**
     * Removes all decorations and tears down event listeners.
     * Must be called when the group is permanently discarded.
     */
    destroy() {
        this.clear();
        this.wnd.document.removeEventListener("pointerup", this.activationHandler);
    }

    private handleActivation(e: PointerEvent) {
        if (!this._activatable) return;
        const cssX = e.clientX;
        const cssY = e.clientY;
        const pixelRatio = this.wnd.devicePixelRatio;

        for (const item of this.items) {
            if (!item.decoration.style?.isActive) continue;

            let hit = false;

            // Range.getClientRects() works for both rendering paths: the CSS Highlight API
            // has no DOM overlay to target, and the DOM overlay divs have pointer-events: none,
            // so in neither case is the decoration element the pointer event target.
            const rects = item.range.getClientRects();
            for (const rect of rects) {
                if (rectContainsPoint(rect as Rect, cssX, cssY, 0)) { 
                    hit = true; 
                    break; 
                }
            }

            if (hit) {
                const r = item.range.getBoundingClientRect();
                this.comms.send("decoration_activated", {
                    decorationId: item.decoration.id,
                    group: this.name,
                    rect: {
                        top: r.top * pixelRatio,
                        left: r.left * pixelRatio,
                        width: r.width * pixelRatio,
                        height: r.height * pixelRatio,
                    },
                    point: { x: cssX * pixelRatio, y: cssY * pixelRatio },
                } as DecorationActivatedEvent);
                return;
            }
        }
    }

    /**
     * Recreates the decoration elements.
     * To be called after reflowing the resource, for example.
     */
    requestLayout() {
        this.wnd.cancelAnimationFrame(this.currentRender);
        this.clearContainer();
        this.items.forEach(i => this.layout(i));
        this.renderLayout(this.items);
    }

    private experimentalLayout(item: DecorationItem) {
        const [stylesheet, highlighter]: [HTMLStyleElement, any] = this.requireContainer(true) as [HTMLStyleElement, unknown];
        highlighter.add(item.range);

        const backgroundColor = getProperty(this.wnd, "--USER__backgroundColor") ||
                              this.wnd.getComputedStyle(this.wnd.document.documentElement).getPropertyValue("background-color");
        const tint = item.decoration?.style?.tint ?? DEFAULT_HIGHLIGHT_COLOR;

        // TODO add caching layer ("vdom") to this so we aren't completely replacing the CSS every time
        stylesheet.innerHTML = `
        ::highlight(${this.id}) {
            color: ${getContrastingTextColor(tint, backgroundColor)};
            background-color: ${tint};
        }`;
    }

    /**
     * Layouts a single DecorationItem.
     * @param item
     */
    private layout(item: DecorationItem) {
        if (this.experimentalHighlights && !this.notTextFlag?.has(item.id)) {
            // Highlight using the new Highlight Web API!
            return this.experimentalLayout(item);
        }
        // this.comms.log("Environment does not support experimental Web Highlight API, can't layout decorations");

        const itemContainer = this.wnd.document.createElement("div");
        itemContainer.setAttribute("id", item.id);
        itemContainer.dataset.highlightId = item.decoration.id;
        // itemContainer.dataset.style = item.decoration.style; // TODO style
        itemContainer.style.setProperty("pointer-events", "none");

        const viewportWidth = this.wnd.innerWidth;
        const columnCount = parseInt(
            getComputedStyle(this.wnd.document.documentElement).getPropertyValue(
                "column-count"
            )
        );
        const pageWidth = viewportWidth / (columnCount || 1);
        const scrollingElement = this.wnd.document.scrollingElement!;
        const xOffset = scrollingElement.scrollLeft;
        const yOffset = scrollingElement.scrollTop;

        const positionElement = (element: HTMLElement, rect: Rect, boundingRect: DOMRect) => {
            element.style.position = "absolute";

            // TODO change to switch
            if (item.decoration?.style?.width === DecorationWidth.Viewport) {
                element.style.width = `${viewportWidth}px`;
                element.style.height = `${rect.height}px`;
                let left = Math.floor(rect.left / viewportWidth) * viewportWidth;
                element.style.left = `${left + xOffset}px`;
                element.style.top = `${rect.top + yOffset}px`;
            } else if (item.decoration?.style?.width === DecorationWidth.Bounds) {
                element.style.width = `${boundingRect.width}px`;
                element.style.height = `${rect.height}px`;
                element.style.left = `${boundingRect.left + xOffset}px`;
                element.style.top = `${rect.top + yOffset}px`;
            } else if (item.decoration?.style?.width === DecorationWidth.Page) {
                element.style.width = `${pageWidth}px`;
                element.style.height = `${rect.height}px`;
                let left = Math.floor(rect.left / pageWidth) * pageWidth;
                element.style.left = `${left + xOffset}px`;
                element.style.top = `${rect.top + yOffset}px`;
            } else {
                // Fall back to "wrap"
                element.style.width = `${rect.width}px`;
                element.style.height = `${rect.height}px`;
                element.style.left = `${rect.left + xOffset}px`;
                element.style.top = `${rect.top + yOffset}px`;
            }
        }

        const boundingRect = item.range.getBoundingClientRect();

        let template = this.wnd.document.createElement("template");
        // template.innerHTML = item.decoration.element.trim();
        // TODO more styles logic

        const isDarkMode = this.getCurrentDarkMode();

        template.innerHTML = `
        <div
            data-readium="true"
            class="readium-highlight"
            style="${[
                `background-color: ${item.decoration?.style?.tint ?? DEFAULT_HIGHLIGHT_COLOR} !important`,
                //"opacity: 0.3 !important",
                `mix-blend-mode: ${isDarkMode ? "exclusion" : "multiply"} !important`,
                "opacity: 1 !important",
                "box-sizing: border-box !important"
            ].join("; ")}"
        >
        </div>
        `.trim();
        const elementTemplate = template.content.firstElementChild!;

        if(item.decoration?.style?.layout === DecorationLayout.Bounds) {
            const bounds = elementTemplate.cloneNode(true) as HTMLDivElement;
            bounds.style.setProperty("pointer-events", "none");
            positionElement(bounds, boundingRect, boundingRect);
            itemContainer.append(bounds);
        } else {
            // Fall back to "boxes" value for layout
            let clientRects = getClientRectsNoOverlap(
              item.range,
              true // doNotMergeHorizontallyAlignedRects
            );

            clientRects = clientRects.sort((r1, r2) => {
              if (r1.top < r2.top) {
                return -1;
              } else if (r1.top > r2.top) {
                return 1;
              } else {
                return 0;
              }
            });

            for (let clientRect of clientRects) {
              const line = elementTemplate.cloneNode(true) as HTMLDivElement;
              line.style.setProperty("pointer-events", "none");
              positionElement(line, clientRect, boundingRect);
              itemContainer.append(line);
            }
        }

        item.container = itemContainer;
        item.clickableElements = Array.from(
            itemContainer.querySelectorAll("[data-activable='1']")
        );
        if(!item.clickableElements.length) {
            item.clickableElements = Array.from(itemContainer.children) as HTMLElement[];
        }
    }

    private currentRender = 0;
    private renderLayout(items: DecorationItem[]) {
        this.wnd.cancelAnimationFrame(this.currentRender);
        this.currentRender = this.wnd.requestAnimationFrame(() => {
            items = items.filter(i => !this.experimentalHighlights || !!this.notTextFlag?.has(i.id));
            if(!items || items.length === 0) return;
            const groupContainer = this.requireContainer() as HTMLDivElement;
            groupContainer.append(...items.map(i => i.container).filter(c => !!c) as Node[])
        });
    }

    /**
     * Returns the group container element, after making sure it exists.
     * @returns Group's container
     */
    private requireContainer(experimental=false): [HTMLStyleElement, any] | HTMLDivElement {
        if (experimental) {
            // Setup <style> for highlights
            let d: HTMLStyleElement;
            if (this.wnd.document.getElementById(`${this.id}-style`)) {
                d = this.wnd.document.getElementById(`${this.id}-style`) as HTMLStyleElement;
            } else {
                d = this.wnd.document.createElement("style");
                d.dataset.readium = "true";
                d.id = `${this.id}-style`;
                this.wnd.document.head.appendChild(d);
            }

            // Setup CSS.highlights
            let h: unknown;
            if (((this.wnd as any).CSS.highlights as Map<string, unknown>).has(this.id)) {
                h = ((this.wnd as any).CSS.highlights as Map<string, unknown>).get(this.id)
            } else {
                h = new (this.wnd as any).Highlight();
                ((this.wnd as any).CSS.highlights as Map<string, unknown>).set(this.id, h);
            }
            return [d, h];
        }

        if (!this.container) {
            this.container = this.wnd.document.createElement("div");
            this.container.setAttribute("id", this.id);
            this.container.dataset.group = this.name;
            this.container.dataset.readium = "true";
            this.container.style.setProperty("pointer-events", "none");
            this.container.style.display = "contents";
            this.wnd.document.body.append(this.container);
        }
        return this.container;
    }

    getCurrentDarkMode(): boolean {
        return getProperty(this.wnd, "--USER__appearance") === "readium-night-on" ||
            isDarkColor(getProperty(this.wnd, "--USER__backgroundColor")) ||
            isDarkColor(this.wnd.getComputedStyle(this.wnd.document.documentElement).getPropertyValue("background-color"));
    }

    /**
     * Removes the group container.
     */
    private clearContainer() {
        if (this.experimentalHighlights) {
            ((this.wnd as any).CSS.highlights as Map<string, unknown>).delete(this.id);
        }
        if (this.container) {
            this.container.remove();
            this.container = undefined;
        }
    }
}

export class Decorator extends Module {
    static readonly moduleName: ModuleName = "decorator";
    private resizeObserver!: ResizeObserver;
    private backgroundObserver!: MutationObserver;
    private wnd!: ReadiumWindow;
    /*private readonly lastSize = {
        width: 0,
        height: 0
    };*/
    private resizeFrame = 0;

    private lastGroupId = 0;
    private groups = new Map<string, DecorationGroup>();

    private cleanup() {
        this.groups.forEach(g => g.destroy());
        this.groups.clear();
    }

    private updateHighlightStyles() {
        this.groups.forEach(group => {
            group.requestLayout();
        });
    }

    private extractCustomProperty(style: string | null, propertyName: string): string | null {
        if (!style) return null;

        const match = style.match(new RegExp(`${propertyName}:\\s*([^;]+)`));
        return match ? match[1].trim() : null;
    }

    private handleResize() {
        this.wnd.clearTimeout(this.resizeFrame);
        this.resizeFrame = this.wnd.setTimeout(() => {
            this.groups.forEach(g => {
                if(!g.experimentalHighlights) g.requestLayout();
            });
        }, 50);
    }
    private readonly handleResizer = this.handleResize.bind(this);

    mount(wnd: ReadiumWindow, comms: Comms): boolean {
        this.wnd = wnd;

        comms.register("decorate", Decorator.moduleName, (data, ack) => {
            const req = data as DecoratorRequest;
            if (req.action === "add" || req.action === "update") {
                if (req.decoration.locator) {
                    req.decoration.locator = Locator.deserialize(req.decoration.locator)!;
                }
            }
            if (!this.groups.has(req.group)) {
                this.groups.set(req.group, new DecorationGroup(
                    wnd,
                    comms,
                    `readium-decoration-${this.lastGroupId++}`,
                    req.group
                ));
            }
            const group = this.groups.get(req.group);
            switch (req.action) {
                case "add":
                    group?.add(req.decoration);
                    break;
                case "remove":
                    group?.remove(req.decoration.id);
                    break;
                case "clear":
                    group?.clear();
                    break;
                case "update":
                    group?.update(req.decoration);
                    break;
            }

            ack(true);
        });

        comms.register("decoration_activatable", Decorator.moduleName, (data, ack) => {
            const req = data as { group: string; activatable: boolean };
            const group = this.groups.get(req.group);
            if (group) {
                group.activatable = req.activatable;
            }
            ack(true);
        });

        this.resizeObserver = new ResizeObserver(() => wnd.requestAnimationFrame(() => this.handleResize()));
        this.resizeObserver.observe(wnd.document.body);
        wnd.addEventListener("orientationchange", this.handleResizer);
        wnd.addEventListener("resize", this.handleResizer);

        // Set up MutationObserver to watch for CSS custom property changes
        this.backgroundObserver = new MutationObserver((mutations) => {
            const shouldUpdate = mutations.some(mutation => {
                if (mutation.type === "attributes" && mutation.attributeName === "style") {
                    const element = mutation.target as Element;
                    const oldStyle = mutation.oldValue;
                    const newStyle = element.getAttribute("style");

                    // Check if the relevant CSS custom properties actually changed
                    const oldAppearance = this.extractCustomProperty(oldStyle, "--USER__appearance");
                    const newAppearance = this.extractCustomProperty(newStyle, "--USER__appearance");
                    const oldBgColor = this.extractCustomProperty(oldStyle, "--USER__backgroundColor");
                    const newBgColor = this.extractCustomProperty(newStyle, "--USER__backgroundColor");

                    return oldAppearance !== newAppearance ||
                           oldBgColor !== newBgColor;
                }
                return false;
            });

            if (shouldUpdate) {
                this.updateHighlightStyles();
            }
        });

        this.backgroundObserver.observe(wnd.document.documentElement, {
            attributes: true,
            attributeFilter: ["style"],
            attributeOldValue: true,
            subtree: true
        });

        comms.log("Decorator Mounted");
        return true;
    }

    unmount(wnd: ReadiumWindow, comms: Comms): boolean {
        wnd.removeEventListener("orientationchange", this.handleResizer);
        wnd.removeEventListener("resize", this.handleResizer);

        comms.unregisterAll(Decorator.moduleName);
        this.resizeObserver.disconnect();
        this.backgroundObserver.disconnect();
        this.cleanup();

        comms.log("Decorator Unmounted");
        return true;
    }
}
