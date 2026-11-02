// Colour fix-ups for D2 sources rendered on the dark theme. No Node imports.

/**
 * Agents often hardcode pastel fills (`style.fill: "#e6f4ea"`); on D2's dark
 * theme those pair with light text and vanish. Keep each light fill's hue but
 * drop its lightness so the theme's text stays readable. Dark fills pass through.
 */
export function darkenFills(source: string): string {
  return source.replace(/(fill\s*:\s*["']?)(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\b/g, (_m, pre: string, hex: string) => {
    const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
    const r = parseInt(full.slice(1, 3), 16) / 255;
    const g = parseInt(full.slice(3, 5), 16) / 255;
    const b = parseInt(full.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (l < 0.55) return `${pre}${hex}`;
    const d = max - min;
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    // Greys stay grey; tinted fills get a little extra saturation so they still read as a tint.
    return `${pre}${hslToHex(h, sat < 0.08 ? sat : Math.min(1, sat * 1.1 + 0.12), 0.26)}`;
  });
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r!)}${toHex(g!)}${toHex(b!)}`;
}
