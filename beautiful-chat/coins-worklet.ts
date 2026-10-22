// "coins" loader: Originkit's Coin Loader (a ring of tumbling coins, WebGL) redrawn
// as a CSS Paint Worklet so it can live in the 14px ::before of a pending row. At that
// size flat ellipses read the same as lit 3D discs: each coin squashes as it turns
// edge-on and brightens as it faces the viewer, while the whole ring rotates.
// app.css drives it with a registered --bui-coin-t (0→1) and --bui-coin-color.

// Original rates: tumble 1.2 rad/s, ring 0.6 rad/s → one exact loop every 2π/0.6 s,
// in which the ring turns once and each coin tumbles twice.
const WORKLET = `
registerPaint("bui-coins", class {
  static get inputProperties() { return ["--bui-coin-t", "--bui-coin-color"]; }
  paint(ctx, size, props) {
    const TAU = Math.PI * 2, N = 8;
    const t = parseFloat(String(props.get("--bui-coin-t"))) || 0;
    const color = String(props.get("--bui-coin-color")).trim() || "#fff";
    const s = Math.min(size.width, size.height);
    const cx = size.width / 2, cy = size.height / 2;
    const ring = s * 0.33, coin = s * 0.12;
    const ringPhase = t * TAU, tumble = t * TAU * 2;
    ctx.fillStyle = color;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      const pa = a + TAU / N - ringPhase;
      const face = Math.abs(Math.cos(tumble + a));
      ctx.save();
      ctx.translate(cx + Math.cos(pa) * ring, cy + Math.sin(pa) * ring);
      ctx.rotate(pa + tumble / 2);
      ctx.globalAlpha = 0.25 + 0.75 * face * face;
      ctx.beginPath();
      ctx.ellipse(0, 0, coin, coin * Math.max(0.12, face), 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }
});
`;

let registration: Promise<boolean> | null = null;

/** Registers the painter once per window; resolves false where Paint Worklets aren't available. */
export function registerCoinsWorklet(): Promise<boolean> {
  if (registration) return registration;
  const paintWorklet = (CSS as unknown as { paintWorklet?: { addModule(url: string): Promise<void> } }).paintWorklet;
  if (!paintWorklet) return (registration = Promise.resolve(false));
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  registration = paintWorklet.addModule(url).then(
    () => true,
    (error: unknown) => {
      console.warn("[beautiful-chat] coins loader unavailable, using drive", error);
      return false;
    },
  );
  return registration;
}
