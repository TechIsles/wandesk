// The shell's half of the browser surface: it owns where a real Chromium page is allowed to paint.
//
// The page (an Electron WebContentsView, see shell/desktop/web.ts) is not in this document — it floats
// above the entire window. So the app tells us the rectangle it wants inside its own frame, and every
// animation frame we translate that into window coordinates and ask whether anything is on top: points
// are probed with elementFromPoint, and unless they land on this app's iframe, something covers the
// area. A few pixels at the edges are the window's own resize handles, which the page steps around
// (otherwise it would swallow the drag); anything deeper — another window, a menu, a dialog — takes
// the page off screen entirely.
// Each hide returns a snapshot, which the app paints in the same spot, so the swap is not visible.
//
// Without the Electron bridge — a plain browser in development — none of this exists and the app is
// told so, rather than being handed an iframe that most sites refuse to load.

export type Rect = { x: number; y: number; w: number; h: number };
type Bridge = {
  create(url: string): Promise<number>;
  destroy(id: number): Promise<boolean>;
  place(id: number, rect: Rect | null): void;
  call(id: number, method: string, args: unknown[]): Promise<unknown>;
  on(fn: (event: any) => void): () => void;
};

const EDGE = 16;     // how far to look for the window's own resize handles before calling the area covered
const COALESCE = 12; // ms: the most often the rectangle is recounted
const EVENTS = ["resize", "scroll", "focus", "blur", "pointerup"] as const;

const bridge = (): Bridge | null => (window as any).wandeskShell?.web ?? null;
export const webAvailable = () => Boolean(bridge());

const same = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** One per app instance that asks for a page. The AppFrame creates it lazily and disposes it on unmount. */
export class WebSurface {
  private ids = new Set<number>();
  private placed: { id: number; rect: Rect } | null = null;
  private sent: { id: number; rect: Rect | null } | null = null;
  private observer: MutationObserver | null = null;
  private timer = 0;
  private soon = 0;
  private last = 0;
  private off: (() => void) | null = null;

  constructor(private host: () => HTMLIFrameElement | null, private emit: (event: any) => void) {
    const web = bridge();
    if (web) this.off = web.on((event) => { if (event.id === 0 || this.ids.has(event.id)) this.emit(event); });
    // What the shell draws decides where the page may be: a window moved, a menu opened, the desktop
    // resized. Every one of those is a change to this document, so watch the document rather than poll
    // — a renderer that is not on screen stops being given animation frames, and a loop built on them
    // would simply stop thinking.
    this.observer = new MutationObserver(this.schedule);
    this.observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    for (const event of EVENTS) window.addEventListener(event, this.schedule, true);
    document.addEventListener("visibilitychange", this.schedule);
    this.timer = window.setInterval(this.schedule, 500); // a floor, for anything the above misses
    this.schedule();
  }

  /** Coalesce: several mutations in one turn are one recount, and never more than one per frame's worth. */
  private schedule = () => {
    const now = performance.now();
    const wait = COALESCE - (now - this.last);
    if (wait > 0) {
      if (!this.soon) this.soon = window.setTimeout(() => { this.soon = 0; this.schedule(); }, wait);
      return;
    }
    this.last = now;
    this.sync();
  };

  async create(url: string) {
    const web = bridge();
    if (!web) throw new Error("A browser page needs the Wandesk desktop app");
    const id = await web.create(url);
    this.ids.add(id);
    return { id };
  }

  async destroy(id: number) {
    if (!this.ids.has(id)) return { ok: true };
    if (this.placed?.id === id) { this.placed = null; this.sent = null; }
    this.ids.delete(id);
    await bridge()?.destroy(id);
    return { ok: true };
  }

  /** The app's frame-relative rectangle for one page; null (or another id) takes the current one off screen. */
  place(id: number, rect: Rect | null) {
    if (!this.ids.has(id)) throw new Error(`No such page: ${id}`);
    if (this.placed && this.placed.id !== id) this.push(this.placed.id, null);
    this.placed = rect ? { id, rect } : null;
    if (!rect) this.push(id, null); else this.sync();
    return { ok: true };
  }

  call(id: number, method: string, args: unknown[]) {
    if (!this.ids.has(id)) throw new Error(`No such page: ${id}`);
    const web = bridge();
    if (!web) throw new Error("A browser page needs the Wandesk desktop app");
    return web.call(id, method, args);
  }

  dispose() {
    this.observer?.disconnect();
    for (const event of EVENTS) window.removeEventListener(event, this.schedule, true);
    document.removeEventListener("visibilitychange", this.schedule);
    clearInterval(this.timer);
    clearTimeout(this.soon);
    this.off?.();
    for (const id of this.ids) void bridge()?.destroy(id);
    this.ids.clear();
    this.placed = null;
  }

  private push(id: number, rect: Rect | null) {
    if (this.sent && this.sent.id === id && same(this.sent.rect, rect)) return;
    this.sent = { id, rect };
    bridge()?.place(id, rect);
  }

  /** Probe one point: the page may paint only where this app's own frame is what the user would click. */
  private hit(frame: HTMLIFrameElement, x: number, y: number) {
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    return document.elementFromPoint(x, y) === frame;
  }

  /** Walk in from each edge past the window's own furniture — the resize handles sit on top of the
   *  frame, and a page painted over them would swallow the drag. A few pixels at most; anything
   *  deeper is something else covering the area and the grid below will say so. */
  private inset(frame: HTMLIFrameElement, r: { left: number; top: number; right: number; bottom: number }) {
    const box = { ...r };
    const midY = () => (box.top + box.bottom) / 2;
    const midX = () => (box.left + box.right) / 2;
    for (let i = 0; i < EDGE && box.left < box.right && !this.hit(frame, box.left + 1, midY()); i++) box.left++;
    for (let i = 0; i < EDGE && box.right > box.left && !this.hit(frame, box.right - 1, midY()); i++) box.right--;
    for (let i = 0; i < EDGE && box.top < box.bottom && !this.hit(frame, midX(), box.top + 1); i++) box.top++;
    for (let i = 0; i < EDGE && box.bottom > box.top && !this.hit(frame, midX(), box.bottom - 1); i++) box.bottom--;
    return box;
  }

  /** Anything drawn over the area — another window, a menu, a dialog — must win. Probed a little way
   *  in from the edges: the window's own corner and edge handles are a few pixels of furniture, not a
   *  reason to blank the page, while anything large enough to matter reaches these points. */
  private covered(frame: HTMLIFrameElement, r: { left: number; top: number; right: number; bottom: number }) {
    const padX = Math.min(EDGE, Math.floor((r.right - r.left) / 4));
    const padY = Math.min(EDGE, Math.floor((r.bottom - r.top) / 4));
    for (const x of [r.left + padX, (r.left + r.right) / 2, r.right - padX]) {
      for (const y of [r.top + padY, (r.top + r.bottom) / 2, r.bottom - padY]) {
        if (!this.hit(frame, x, y)) return true;
      }
    }
    return false;
  }

  private sync() {
    const placed = this.placed;
    if (!placed) return;
    const frame = this.host();
    const box = frame?.getBoundingClientRect();
    if (!frame || !box || box.width < 2 || box.height < 2) { this.push(placed.id, null); return; }

    // Clip the app's rectangle to the frame: a window resized smaller must not leave the page hanging out
    const clipped = {
      left: Math.max(box.left, box.left + placed.rect.x),
      top: Math.max(box.top, box.top + placed.rect.y),
      right: Math.min(box.right, box.left + placed.rect.x + placed.rect.w),
      bottom: Math.min(box.bottom, box.top + placed.rect.y + placed.rect.h),
    };
    if (clipped.right - clipped.left < 2 || clipped.bottom - clipped.top < 2) { this.push(placed.id, null); return; }

    const area = this.inset(frame, clipped);
    const rect: Rect = { x: Math.round(area.left), y: Math.round(area.top), w: Math.round(area.right - area.left), h: Math.round(area.bottom - area.top) };
    if (rect.w < 2 || rect.h < 2 || this.covered(frame, area)) { this.push(placed.id, null); return; }
    this.push(placed.id, rect);
  }
}
