import React, { useEffect } from 'react';
import { Linking, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { marketController } from './src/state/MarketController';
import { TradingScreen } from './src/ui/TradingScreen';
import { theme } from './src/ui/theme';
import { parseSymbolFromUrl } from './src/util/deeplink';

/**
 * App root.
 *
 * Responsibilities kept deliberately small: mount the gesture and safe-area providers, own the
 * controller's lifetime, and handle deep links. All market logic lives below this.
 *
 * GestureHandlerRootView must wrap the tree for react-native-gesture-handler, which the chart's
 * crosshair, pan and pinch all depend on. Without it gestures silently do nothing rather than
 * erroring, which is a confusing failure to diagnose.
 */
export default function App(): React.JSX.Element {
  /**
   * Start the controller once for the app's lifetime, and tear it down on unmount.
   *
   * The empty dependency array is load-bearing: if this effect re-ran, it would dispose a live
   * socket and open a new one, which would look like a random reconnect. The controller is a
   * module singleton for the same reason - its lifetime is the app's, not a component's.
   *
   * The cleanup disposes the socket, cancels in-flight requests, removes the AppState listener
   * and clears every timer, which is the "dispose of connections and subscriptions when
   * appropriate" requirement.
   */
  useEffect(() => {
    marketController.start();
    return () => marketController.stop();
  }, []);

  /**
   * Deep linking, e.g. twospoon://symbol/BTC-USDT
   *
   * Both entry paths must be handled, and they are genuinely different:
   *
   *   COLD START - the app was not running. The URL is already waiting, so it must be READ via
   *                getInitialURL(). No event will ever fire for it.
   *   WARM START - the app was running. Android delivers the intent to the existing activity
   *                (launchMode is singleTask), which surfaces as a 'url' EVENT.
   *
   * Handling only one is the usual bug: the link works from a cold start but is ignored when the
   * app is already open, or vice versa.
   *
   * With a single simulated symbol there is nothing to switch to, so this validates and logs the
   * target rather than pretending to navigate. The parsing and both lifecycle paths are the part
   * that generalises to a multi-symbol app.
   */
  useEffect(() => {
    // `getInitialURL` resolves to `string | null | undefined` in RN 0.87, so the parameter has
    // to admit undefined as well as null.
    const handleUrl = (url: string | null | undefined): void => {
      if (!url) return;
      const symbol = parseSymbolFromUrl(url);
      if (!symbol) return;
      // A single-symbol backend: nothing to navigate to, but the link resolved correctly.
      console.log(`[deeplink] resolved symbol: ${symbol}`);
    };

    void Linking.getInitialURL().then(handleUrl);
    const subscription = Linking.addEventListener('url', (event) => handleUrl(event.url));
    return () => subscription.remove();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <TradingScreen />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.color.bg,
  },
});
