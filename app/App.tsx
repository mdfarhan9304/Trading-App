import React, { useEffect } from 'react';
import { Linking, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { marketController } from './src/state/MarketController';
import { TradingScreen } from './src/ui/TradingScreen';
import { theme } from './src/ui/theme';
import { parseSymbolFromUrl } from './src/util/deeplink';

export default function App(): React.JSX.Element {
  useEffect(() => {
    marketController.start();
    return () => marketController.stop();
  }, []);

  // cold start = getInitialURL, warm start = 'url' event. need both.
  useEffect(() => {
    const handleUrl = (url: string | null | undefined): void => {
      if (!url) return;
      const symbol = parseSymbolFromUrl(url);
      if (!symbol) return;
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
