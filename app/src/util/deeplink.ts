const PREFIX = 'twospoon://symbol/';

// parse by hand — RN's URL polyfill is flaky with custom schemes
export function parseSymbolFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.startsWith(PREFIX)) return null;

  const rest = url.slice(PREFIX.length).split(/[?#]/)[0] ?? '';
  if (rest === '') return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null; // bad percent-escape
  }

  const symbol = decoded.trim().toUpperCase();
  return /^[A-Z0-9]{2,10}-[A-Z0-9]{2,10}$/.test(symbol) ? symbol : null;
}
