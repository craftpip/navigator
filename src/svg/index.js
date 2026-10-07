export { withStageDeadline, SvgStageTimeoutError, SVG_FONT_STAGE_TIMEOUT_MS, SVG_EXTRACT_STAGE_TIMEOUT_MS, SVG_DIMS_STAGE_TIMEOUT_MS } from './deadline.js';
// src/svg/index.js — barrel for multi-agent ownership. Single import path for consumers.
// Agents: A=extractor, B=text, C=style, D=builder, E=capture, F=pdf+merge

export { svgExtractor } from './extractor.js';
export { capturePageAsSvg } from './capture.js';
export { buildSvg, formatLegend } from './builder.js';
export { escapeXml, clampRadius, parseRadius, parseRadii, radiiEqual, buildRadiusPath, isTransparentColor, rectContains, shouldSkipContainerText, NARROW_GLYPHS, WIDE_GLYPHS } from './utils.js';
export { measureTextWidth, maxCharsFitting, appendEllipsis, wrapTextToWidth, wrapWithWordWidths } from './text.js';
export { parseSimpleLinearGradient, parseSimpleRadialGradient, parseSingleBoxShadowToken, parseBoxShadows, parseSimpleBoxShadow } from './style.js';
export { capturePageAsPdf, getPageDimensions, scaleSvgToViewport } from './capture-pdf.js';
export { captureDomSnapshot, DOMSNAPSHOT_SCRIPT } from './dom-snapshot.js';
export { mergeLayers } from './merge-layers.js';
