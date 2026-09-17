/**
 * Deep link parsing.
 *
 * Lives in its own module rather than in App.tsx so it can be unit tested without mounting the
 * React tree. Importing App.tsx into a test drags in gesture-handler and the whole native
 * surface, which is a lot of machinery to exercise a string parser.
 */

/** The scheme registered in AndroidManifest.xml. */
const PREFIX = 'twospoon://symbol/';

/**
 * Extract the symbol from `twospoon://symbol/BTC-USDT`.
 *
 * Parsed by hand rather than with the `URL` API because React Native's URL polyfill is
 * incomplete for custom schemes - `new URL('twospoon://symbol/BTC-USDT').pathname` is not
 * reliable across platforms.
 *
 * Returns null for anything unrecognised instead of throwing, so a malformed link delivered at
 * cold start cannot crash the app before it renders. The pattern check also means a link cannot
 * inject arbitrary text into the UI.
 */
export function parseSymbolFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.startsWith(PREFIX)) return null;

  // Strip any query string or fragment before decoding.
  const rest = url.slice(PREFIX.length).split(/[?#]/)[0] ?? '';
  if (rest === '') return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // A malformed percent-escape, e.g. "%E0%A4%A". decodeURIComponent throws on these.
    return null;
  }

  const symbol = decoded.trim().toUpperCase();
  return /^[A-Z0-9]{2,10}-[A-Z0-9]{2,10}$/.test(symbol) ? symbol : null;
}
