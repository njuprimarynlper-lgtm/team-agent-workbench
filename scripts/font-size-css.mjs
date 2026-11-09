// Adjust explicit sizes and compensate relative sizes for their adjusted parent.
export function adjustableFontSizes(css) {
  return css
    .replace(/(\bfont-size\s*:\s*)(\d+(?:\.\d+)?)px\b/gi,
      '$1calc($2px + var(--workbench-font-step, 0px))')
    .replace(/(\bfont-size\s*:\s*)(\d*\.?\d+)em\b/gi, (_match, prefix, value) => {
      const correction = Number(value) - 1;
      if (!correction) return `${prefix}${value}em`;
      const operator = correction > 0 ? '-' : '+';
      return `${prefix}calc(${value}em ${operator} var(--workbench-font-step, 0px) * ${Math.abs(correction)})`;
    });
}
