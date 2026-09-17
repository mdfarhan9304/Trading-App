import { Platform } from 'react-native';

/**
 * Visual tokens.
 *
 * A dark palette because that is what trading screens use, and because it makes the green/red
 * of price movement read clearly without shouting. Colours are chosen so up/down remain
 * distinguishable by brightness as well as hue, which keeps them legible for the most common
 * forms of colour blindness.
 */
export const theme = {
  color: {
    bg: '#0B0E11',
    surface: '#141A20',
    surfaceAlt: '#1B232B',
    border: '#242F3A',

    text: '#EAEFF4',
    textDim: '#8A9AA9',
    textFaint: '#5A6976',

    up: '#0ECB81',
    upDim: '#0b7a4e',
    down: '#F6465D',
    downDim: '#95293a',

    accent: '#F0B90B',
    live: '#0ECB81',
    warn: '#F0B90B',
    bad: '#F6465D',
    neutral: '#5A6976',
  },

  space: (n: number) => n * 4,

  radius: {
    sm: 4,
    md: 8,
    lg: 14,
  },

  font: {
    /**
     * A monospaced family for every number.
     *
     * Non-negotiable on this screen: with proportional digits, a price ticking from 104,523.45
     * to 104,511.11 changes width and the whole row jitters. Tabular figures keep columns
     * still, which matters more when values update ten times a second.
     */
    mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    size: {
      xs: 10,
      sm: 12,
      md: 14,
      lg: 18,
      xl: 32,
    },
  },
} as const;

/** Skia needs a font family name it can resolve natively; these exist on each platform. */
export const skiaFontFamily = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
}) as string;
