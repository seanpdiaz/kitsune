import { hexToRgbParts } from '../../public/js/lib/colors.js';

// tagChipStyle() in public/js/lib/colors.js returns a CSS text string meant
// for a plain `style="..."` HTML attribute — React's style prop needs an
// object instead, so every React tag-chip (Settings > Tags, the Library
// grid's Table/Overview views, Series detail's Edit modal) shares this one
// conversion rather than each re-deriving it from hexToRgbParts() on its own.
export function tagChipStyleObj(hex) {
  const { r, g, b } = hexToRgbParts(hex);
  // Text is the tag color mixed toward black by the theme's --tag-ink-mix
  // (100% = unchanged on dark themes), so yellow/teal tags stay readable
  // on light ones. Fill and border stay translucent tag color everywhere.
  return { background: `rgba(${r},${g},${b},0.16)`, color: `color-mix(in srgb, ${hex} var(--tag-ink-mix, 100%), #000)`, borderColor: `rgba(${r},${g},${b},0.45)` };
}
