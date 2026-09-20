import { Platform } from 'react-native';

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
    // mono so ticking prices don't shift width
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

export const skiaFontFamily = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
}) as string;
