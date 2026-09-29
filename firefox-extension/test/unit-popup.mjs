#!/usr/bin/env node
/**
 * Firefox popup DOM tests — thin runner for the shared suite.
 *
 * The assertions live in chrome-extension/test/unit-popup.mjs because both
 * extensions implement identical description logic in their popups; running
 * the same file against both trees is what keeps them from drifting.
 *
 * The shared suite reads the tree under test from process.argv[2], defaulting
 * to the tree it lives in. A static `import` is hoisted and evaluated BEFORE
 * this file's body runs, so the argument has to be set first and the suite
 * pulled in dynamically — otherwise a bare
 * `node firefox-extension/test/unit-popup.mjs` would quietly re-test the Chrome
 * tree and report a green run that proved nothing.
 */
import { fileURLToPath } from 'url';

const FIREFOX_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '');
process.argv[2] = process.argv[2] || FIREFOX_ROOT;

await import('../../chrome-extension/test/unit-popup.mjs');
