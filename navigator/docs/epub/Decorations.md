# Decorations

`EpubNavigator` implements `DecorableNavigator`, which lets you visually annotate text in a publication — highlights, underlines, search results, TTS position indicators, and anything else that needs to sit on top of content.

The API is defined by [Readium Architecture RFC 008](https://readium.org/architecture/proposals/008-decorator-api.html).

## Concepts

### Decoration

A `Decoration` marks a single location in a publication with a visual style:

```ts
interface Decoration {
  id: string;                           // Must be unique within its group
  locator: Locator;                     // Where in the publication to render
  style: DecorationStyle;               // How it looks
  extras?: Record<string, unknown>;     // App-specific data (passed back on activation)
}
```

### DecorationStyle

`DecorationStyle` controls the appearance:

```ts
interface DecorationStyle {
  tint: string;                 // Any CSS color — "#ffff00", "rgba(255,200,0,0.4)", etc.
  layout: DecorationLayout;     // DecorationLayout.Boxes | DecorationLayout.Bounds
  width: DecorationWidth;       // DecorationWidth.Wrap | DecorationWidth.Viewport | DecorationWidth.Page | DecorationWidth.Bounds
  isActive?: boolean;           // Set to true to allow the user to click/tap this decoration
}
```

**`DecorationLayout`**

| Value | Description |
|---|---|
| `DecorationLayout.Boxes` | One element per CSS border box (i.e. per line of text). Best for highlights. |
| `DecorationLayout.Bounds` | A single element covering the bounding box of the whole range. Best for margin icons. |

**`DecorationWidth`**

| Value | Description |
|---|---|
| `DecorationWidth.Wrap` | Fits the text exactly (default). |
| `DecorationWidth.Viewport` | Stretches to the full viewport width. |
| `DecorationWidth.Page` | Fills one page in a paginated layout. |
| `DecorationWidth.Bounds` | Fills the anchor page (useful in dual-page FXL). |

### Groups

Every decoration belongs to a named group. Groups let you manage unrelated sets of decorations independently — for example `"search"`, `"highlights"`, and `"tts"` can coexist without interfering with each other.

Decoration IDs must be **unique within their group**, but the same ID can appear in different groups.

## Applying Decorations

Call `applyDecorations` with the **complete desired state** for a group. The navigator diffs the new list against the previous one and sends only the necessary add / update / remove commands to the rendered frames.

```ts
import { Decoration, DecorationLayout, DecorationWidth } from "@readium/navigator";

const highlights: Decoration[] = [
  {
    id: "highlight-1",
    locator: myLocator,
    style: {
      tint: "#ffff00",
      layout: DecorationLayout.Boxes,
      width: DecorationWidth.Wrap,
    },
  },
];

navigator.applyDecorations(highlights, "user-highlights");
```

To update, simply call `applyDecorations` again with the new state:

```ts
// Change the tint of highlight-1 and add highlight-2
navigator.applyDecorations([
  { id: "highlight-1", locator: locator1, style: { tint: "#90ee90", layout: DecorationLayout.Boxes, width: DecorationWidth.Wrap } },
  { id: "highlight-2", locator: locator2, style: { tint: "#ffb6c1", layout: DecorationLayout.Boxes, width: DecorationWidth.Wrap } },
], "user-highlights");
```

To remove all decorations from a group, pass an empty array:

```ts
navigator.applyDecorations([], "user-highlights");
```

Decorations are **automatically reapplied** when the navigator loads a new resource (including after navigating away and back), so you do not need to call `applyDecorations` again on navigation.

## Checking DecorationStyle Support

Before enabling a feature that relies on a specific style, you can verify the navigator supports it:

```ts
if (navigator.supportsDecorationStyle({ tint: "#ffff00", layout: DecorationLayout.Boxes, width: DecorationWidth.Wrap })) {
  // safe to apply
}
```

This always returns `true` for `EpubNavigator` — it is mainly useful for navigator-agnostic code.

## Activation (Click / Tap)

To make a decoration respond to user interaction, set `isActive: true` in its style and register a `DecorationObserver` for the group.

```ts
import { DecorationObserver, DecorationActivationEvent } from "@readium/navigator";

const highlightObserver: DecorationObserver = {
  onDecorationActivated(event: DecorationActivationEvent): boolean {
    console.log("Decoration tapped:", event.decoration.id);
    console.log("Group:", event.group);
    console.log("Bounding rect (navigator coords):", event.rect);
    console.log("Tap point (navigator coords):", event.point);
    console.log("App data:", event.decoration.extras);

    // Return true to indicate you handled the event.
    // This suppresses the default tap/click navigation (page turn, miscPointer, etc.).
    return true;
  },
};

navigator.registerDecorationObserver("user-highlights", highlightObserver);
```

Then create the decoration with `isActive: true`:

```ts
navigator.applyDecorations([
  {
    id: "highlight-1",
    locator: myLocator,
    style: {
      tint: "#ffff00",
      layout: DecorationLayout.Boxes,
      width: DecorationWidth.Wrap,
      isActive: true,        // ← required for activation events
    },
    extras: { noteId: "note-42" },  // ← passed through to DecorationActivationEvent
  },
], "user-highlights");
```

### `DecorationActivationEvent`

```ts
interface DecorationActivationEvent {
  decoration: Decoration;   // The full decoration that was activated
  group: string;            // The group it belongs to
  rect?: {                  // Bounding rect in navigator container coordinates
    top: number;
    left: number;
    width: number;
    height: number;
  };
  point?: {                 // Tap/click point in navigator container coordinates
    x: number;
    y: number;
  };
}
```

`rect` and `point` are in CSS pixels relative to the navigator's container element — you can use them to position a popover:

```ts
onDecorationActivated(event: DecorationActivationEvent): boolean {
  if (!event.rect) return false;

  showPopover({
    content: lookupNote(event.decoration.extras?.noteId as string),
    anchorRect: event.rect,
  });

  return true;
}
```

### Return value

Returning `true` from `onDecorationActivated` tells the navigator that you handled the event. The navigator will **not** process the tap/click further — no page turn, no `miscPointer`, no `tap`/`click` listener call.

Returning `false` (or not having a registered observer) lets the tap/click fall through to normal navigation.

### Unregistering an observer

```ts
navigator.unregisterDecorationObserver(highlightObserver);
```

This removes the observer from **all** groups it was registered in.

## Complete Example — User Highlights

```ts
import {
  EpubNavigator,
  Decoration,
  DecorationObserver,
  DecorationActivationEvent,
  DecorationLayout,
  DecorationWidth,
} from "@readium/navigator";

// 1. Keep your highlights in application state
let highlights: Decoration[] = [];

function syncHighlights() {
  navigator.applyDecorations(highlights, "highlights");
}

// 2. Register an observer before or after load
const observer: DecorationObserver = {
  onDecorationActivated(event: DecorationActivationEvent): boolean {
    const noteId = event.decoration.extras?.noteId as string | undefined;
    if (noteId && event.rect) {
      showNotePopover(noteId, event.rect);
      return true;
    }
    return false;
  },
};

navigator.registerDecorationObserver("highlights", observer);

// 3. Add a highlight (e.g. from a user selection)
function addHighlight(locator: Locator, color: string, noteId: string) {
  highlights = [
    ...highlights,
    {
      id: crypto.randomUUID(),
      locator,
      style: { tint: color, layout: DecorationLayout.Boxes, width: DecorationWidth.Wrap, isActive: true },
      extras: { noteId },
    },
  ];
  syncHighlights();
}

// 4. Remove a highlight
function removeHighlight(id: string) {
  highlights = highlights.filter(h => h.id !== id);
  syncHighlights();
}

// 5. Clean up when done
navigator.unregisterDecorationObserver(observer);
await navigator.destroy();
```

## Complete Example — Search Results

Search results are a good example of non-activatable decorations managed alongside activatable ones.

```ts
import { Decoration, DecorationLayout, DecorationWidth } from "@readium/navigator";

function applySearchResults(locators: Locator[], currentMatchId: string) {
  const decorations: Decoration[] = locators.map((locator, i) => ({
    id: `match-${i}`,
    locator,
    style: {
      tint: `match-${i}` === currentMatchId ? "#ff8c00" : "#ffff99",
      layout: DecorationLayout.Boxes,
      width: DecorationWidth.Wrap,
    },
  }));

  navigator.applyDecorations(decorations, "search");
}

function clearSearch() {
  navigator.applyDecorations([], "search");
}
```

Because `isActive` is not set, tapping a search result falls through to normal navigation — no observer needed.
