module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    /**
     * Required by Reanimated 4 and, transitively, by react-native-skia.
     *
     * In Reanimated 3 this was `react-native-reanimated/plugin`. Reanimated 4 moved the
     * worklet transform into the separate `react-native-worklets` package, so that is what
     * must be listed here. Using the old path silently produces a build where every worklet
     * runs on the JS thread instead of the UI thread, which shows up as janky gestures
     * rather than as an error - so it is worth being explicit about.
     *
     * It MUST be the last plugin in the list: it rewrites function bodies, and any plugin
     * running after it would be operating on already-transformed worklet code.
     */
    'react-native-worklets/plugin',
  ],
};
