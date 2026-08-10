// Hex-color -> RGB parts + a ready-to-use inline style string for tag
// chips (used on both the Tags settings page and the Edit Series modal's
// tag picker on the series detail page).

function hexToRgbParts(hex) {
  const clean = String(hex || '').replace('#', '');
  const n = parseInt(clean.length === 6 ? clean : 'f2703d', 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function tagChipStyle(hex) {
  const { r, g, b } = hexToRgbParts(hex);
  return `background: rgba(${r},${g},${b},0.16); color: ${hex}; border-color: rgba(${r},${g},${b},0.45);`;
}

export { hexToRgbParts, tagChipStyle };
