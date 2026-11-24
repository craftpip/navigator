const UPPER_HALF = "▀";
const FULL_BLOCK = "█";
const ESC = "\x1b[";
const MARKER_FG = [0, 0, 0];
const MARKER_BG = [255, 220, 0];
const RAMP_DARK_BG = " .:-=+*#%@";
const RAMP_LIGHT_BG = "@%#*+=-:. ";

function colorCode(prefix, [r, g, b]) {
  return `${ESC}${prefix};2;${r};${g};${b}m`;
}

function luminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function meanLuminance(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 3) {
    sum += luminance([samples[i], samples[i + 1], samples[i + 2]]);
  }
  return sum / (samples.length / 3);
}

function buildCellGrid(samples, cols, rows, mode = "color_ansi") {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(null));

  if (mode === "ascii") {
    const ramp = meanLuminance(samples) >= 128 ? RAMP_LIGHT_BG : RAMP_DARK_BG;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const topI = ((r * 2) * cols + c) * 3;
        const botI = ((r * 2 + 1) * cols + c) * 3;
        const lum = (luminance([samples[topI], samples[topI + 1], samples[topI + 2]])
          + luminance([samples[botI], samples[botI + 1], samples[botI + 2]])) / 2;
        const idx = Math.max(0, Math.min(ramp.length - 1, Math.round((lum / 255) * (ramp.length - 1))));
        grid[r][c] = { ch: ramp[idx], fg: null, bg: null };
      }
    }
    return grid;
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const topI = ((r * 2) * cols + c) * 3;
      const botI = ((r * 2 + 1) * cols + c) * 3;
      let top = [samples[topI], samples[topI + 1], samples[topI + 2]];
      let bot = [samples[botI], samples[botI + 1], samples[botI + 2]];

      if (mode === "grayscale_ansi") {
        const tl = Math.round(luminance(top));
        const bl = Math.round(luminance(bot));
        top = [tl, tl, tl];
        bot = [bl, bl, bl];
      }

      const same = top[0] === bot[0] && top[1] === bot[1] && top[2] === bot[2];
      grid[r][c] = same
        ? { ch: FULL_BLOCK, fg: top, bg: null }
        : { ch: UPPER_HALF, fg: top, bg: bot };
    }
  }

  return grid;
}

function placeMarkers(grid, elements, cols, rows, viewportWidth, viewportHeight) {
  const placed = [];
  const occupied = new Set();
  const scaleX = cols / viewportWidth;
  const scaleY = rows / viewportHeight;

  const sorted = [...elements].sort(
    (a, b) => (a.priority || 99) - (b.priority || 99)
  );

  for (const el of sorted) {
    const rect = el.rect;
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;

    // Clamp into the grid: an element that starts above/left of the capture
    // (negative y/x) is marked on its first visible row/column instead of
    // writing outside the grid.
    let col = Math.min(cols - 1, Math.max(0, Math.round(rect.x * scaleX)));
    const row = Math.min(rows - 1, Math.max(0, Math.round(rect.y * scaleY)));
    if (rect.y * scaleY >= rows || (rect.y + rect.height) * scaleY < 0) continue;

    const marker = `[${el.index}]`;
    const width = marker.length;
    if (col + width > cols) col = Math.max(0, cols - width);

    let tryRow = row;
    while (tryRow < rows) {
      let clear = true;
      for (let i = 0; i < width; i++) {
        if (occupied.has(tryRow * cols + col + i)) {
          clear = false;
          break;
        }
      }
      if (clear) break;
      tryRow++;
    }
    if (tryRow >= rows) continue;

    for (let i = 0; i < width; i++) {
      grid[tryRow][col + i] = {
        ch: marker[i],
        fg: MARKER_FG,
        bg: MARKER_BG,
      };
      occupied.add(tryRow * cols + col + i);
    }
    placed.push({ index: el.index, row: tryRow, col });
  }

  return placed;
}

function renderGrid(grid, cols, rows) {
  const out = [];

  for (let r = 0; r < rows; r++) {
    let line = "";
    let curFg = null;
    let curBg = null;

    for (let c = 0; c < cols; c++) {
      const cell = grid[r][c];
      const fgKey = cell.fg ? cell.fg.join(",") : null;
      const bgKey = cell.bg ? cell.bg.join(",") : null;

      if (fgKey !== curFg) {
        if (cell.fg) line += colorCode("38", cell.fg);
        else line += `${ESC}39m`;
        curFg = fgKey;
      }
      if (bgKey !== curBg) {
        if (cell.bg) line += colorCode("48", cell.bg);
        else line += `${ESC}49m`;
        curBg = bgKey;
      }

      line += cell.ch;
    }

    line += `${ESC}0m`;
    out.push(line);
  }

  return out.join("\n");
}

function renderPlain(grid, cols, rows) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      line += grid[r][c].ch;
    }
    out.push(line);
  }
  return out.join("\n");
}

function formatLegend(elements, options = {}) {
  const includeSelector = options.includeSelector !== false;
  const includeXpath = options.includeXpath !== false;

  const headerParts = ["#", "Kind", "Tag"];
  const sepParts = ["---", "------", "-----"];
  if (includeSelector) {
    headerParts.push("Selector");
    sepParts.push("----------");
  }
  if (includeXpath) {
    headerParts.push("XPath");
    sepParts.push("-------");
  }
  headerParts.push("Text");
  sepParts.push("------");

  const rows = [
    `| ${headerParts.join(" | ")} |`,
    `| ${sepParts.join(" | ")} |`,
  ];

  for (const el of elements) {
    const text = (el.text || "")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ")
      .trim()
      .slice(0, 80);
    const cells = [
      String(el.index),
      el.kind || "—",
      `\`${el.tagName || "?"}\``,
    ];
    if (includeSelector) {
      cells.push((el.selector || "—").replace(/\|/g, "\\|").slice(0, 60));
    }
    if (includeXpath) {
      cells.push((el.xpath || "—").replace(/\|/g, "\\|").slice(0, 60));
    }
    cells.push(text || "—");
    rows.push(`| ${cells.join(" | ")} |`);
  }

  return rows.join("\n");
}

function transform(samples, cols, rows, elements, viewportWidth, viewportHeight, options = {}) {
  const mode = options.mode || "color_ansi";
  const grid = buildCellGrid(samples, cols, rows, mode);
  const placed = placeMarkers(grid, elements, cols, rows, viewportWidth, viewportHeight);
  const ansi = mode === "ascii" ? renderPlain(grid, cols, rows) : renderGrid(grid, cols, rows);
  const legend = formatLegend(elements, options);

  return {
    ansi,
    legend,
    placed,
    stats: {
      asciiCols: cols,
      asciiRows: rows,
      mode,
      viewportWidth,
      viewportHeight,
      elementCount: elements.length,
      placedCount: placed.length,
    },
  };
}

export { buildCellGrid, placeMarkers, renderGrid, renderPlain, formatLegend, transform };
