import { type RefObject, useEffect, useRef } from "react";

export interface GridParams {
  distortion: number;
  radius: number;
  spacing: number;
  dotSize: number;
  glow: number;
  base: number;
}

export interface GridParamMeta {
  min: number;
  max: number;
  step: number;
  label: string;
}

export const GRID_DEFAULTS: GridParams = {
  distortion: 1.6,
  radius: 170,
  spacing: 36,
  dotSize: 1.2,
  glow: 0.85,
  base: 0.26,
};

export const GRID_META: Record<keyof GridParams, GridParamMeta> = {
  distortion: { min: 0.4, max: 4, step: 0.1, label: "distortion" },
  radius: { min: 90, max: 420, step: 10, label: "radius" },
  spacing: { min: 22, max: 64, step: 2, label: "spacing" },
  dotSize: { min: 0.6, max: 2.6, step: 0.1, label: "dot size" },
  glow: { min: 0, max: 1, step: 0.05, label: "glow" },
  base: { min: 0.08, max: 0.6, step: 0.02, label: "quietness" },
};

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  let h = (hex || "").trim().replace("#", "");
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const n = Number.parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Fisheye dot-grid background — the artifact's canvas loop, theme-reactive. */
export function useDotGrid(canvasRef: RefObject<HTMLCanvasElement | null>, params: GridParams): void {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const TAU = Math.PI * 2;
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let colDot: Rgb = { r: 34, g: 42, b: 56 };
    let colHi: Rgb = { r: 122, g: 162, b: 255 };
    const readColors = () => {
      const cs = getComputedStyle(document.documentElement);
      colDot = hexToRgb(cs.getPropertyValue("--dot"));
      colHi = hexToRgb(cs.getPropertyValue("--dot-hi"));
    };

    let W = 0;
    let H = 0;
    let dots: { x: number; y: number }[] = [];
    let builtSpacing = paramsRef.current.spacing;
    const buildGrid = () => {
      const s = paramsRef.current.spacing;
      builtSpacing = s;
      dots = [];
      const cols = Math.floor(W / s);
      const rows = Math.floor(H / s);
      const ox = (W - (cols - 1) * s) / 2;
      const oy = (H - (rows - 1) * s) / 2;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) dots.push({ x: ox + c * s, y: oy + r * s });
    };
    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      W = innerWidth;
      H = innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildGrid();
    };

    let fx = 0;
    let fy = 0;
    let tx = 0;
    let ty = 0;
    let hasMouse = false;
    let lastMove = -1e9;
    let hidden = false;
    const onMove = (e: PointerEvent) => {
      tx = e.clientX;
      ty = e.clientY;
      hasMouse = true;
      lastMove = performance.now();
    };
    const onLeave = () => {
      hasMouse = false;
    };
    const onVisibility = () => {
      hidden = document.hidden;
    };

    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (hidden) return;
      const p = paramsRef.current;
      if (p.spacing !== builtSpacing) buildGrid();
      const idle = !hasMouse || now - lastMove > 2600;
      if (idle && !reduceMotion) {
        const t = now * 0.00015;
        tx = W / 2 + Math.cos(t) * Math.min(W, H) * 0.2;
        ty = H * 0.6 + Math.sin(t * 0.9) * Math.min(W, H) * 0.12;
      } else if (idle && reduceMotion) {
        tx = -1e5;
        ty = -1e5;
      }
      const ease = reduceMotion ? 1 : 0.15;
      fx += (tx - fx) * ease;
      fy += (ty - fy) * ease;
      const R = p.radius;
      const D = p.distortion;
      const R2 = R * R;
      let k0 = Math.exp(D);
      k0 = (k0 / (k0 - 1)) * R;
      const k1 = D / R;
      ctx.clearRect(0, 0, W, H);
      for (const dot of dots) {
        const dx = dot.x - fx;
        const dy = dot.y - fy;
        const d2 = dx * dx + dy * dy;
        let px = dot.x;
        let py = dot.y;
        let t = 0;
        if (d2 < R2) {
          const dd = Math.sqrt(d2);
          if (dd > 0.5) {
            const k = ((k0 * (1 - Math.exp(-dd * k1))) / dd) * 0.75 + 0.25;
            px = fx + dx * k;
            py = fy + dy * k;
            t = Math.max(0, Math.min(1, (k - 1) / 1.4));
          }
        }
        const rad = p.dotSize * (1 + t * 1.7);
        const cT = t * p.glow;
        const r = (colDot.r + (colHi.r - colDot.r) * cT) | 0;
        const g = (colDot.g + (colHi.g - colDot.g) * cT) | 0;
        const b = (colDot.b + (colHi.b - colDot.b) * cT) | 0;
        const a = p.base + (0.9 - p.base) * cT;
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, TAU);
        ctx.fillStyle = `rgba(${r},${g},${b},${a.toFixed(3)})`;
        ctx.fill();
      }
    };

    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const observer = new MutationObserver(readColors);

    readColors();
    scheme.addEventListener("change", readColors);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    addEventListener("pointermove", onMove, { passive: true });
    addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    addEventListener("resize", resize);
    resize();
    fx = tx = W / 2;
    fy = ty = H * 0.6;
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", resize);
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      scheme.removeEventListener("change", readColors);
      observer.disconnect();
    };
  }, [canvasRef]);
}
