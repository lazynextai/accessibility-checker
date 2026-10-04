// File: src/mobileScanner.js
import { HTMLParser } from './scanner.js';

/**
 * Mobile-specific HTML elements to support.
 * @enum {string}
 */
const MOBILE_ELEMENTS = {
  VIEWPORT: 'meta[name="viewport"]',
  TOUCH_CALL: 'a[href^="tel:"]',
  MOBILE_IMAGE: 'img[width^="100%"]',
};

/**
 * Scans mobile-specific HTML elements.
 * @param {Document} document - The HTML document to scan.
 * @returns {Object} - The scan results.
 */
export function scanMobileElements(document) {
  const results = {};
  Object.values(MOBILE_ELEMENTS).forEach((element) => {
    const elements = document.querySelectorAll(element);
    results[element] = elements.length > 0;
  });
  return results;
}

/**
 * Integrates mobile scanning logic into the existing HTML parsing framework.
 * @param {HTMLParser} parser - The HTML parser instance.
 * @param {Document} document - The HTML document to parse.
 * @returns {Object} - The parsing results.
 */
export function integrateMobileScanning(parser, document) {
  const parsingResults = parser.parse(document);
  const mobileScanResults = scanMobileElements(document);
  return { ...parsingResults, mobile: mobileScanResults };
}