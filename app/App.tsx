import React, { useEffect } from 'react';
import { BackHandler, Linking, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { isLiveSymbol } from './src/domain/watchlist';
import { marketController } from './src/state/MarketController';
import { useSessionStore } from './src/state/stores';
import { CatalogDetailScreen } from './src/ui/screens/CatalogDetailScreen';
import { TradingScreen } from './src/ui/screens/TradingScreen';
import { WatchlistScreen } from './src/ui/screens/WatchlistScreen';
import { theme } from './src/ui/theme';
import { routeFromDeepLink } from './src/util/deeplink';

export default function App(): React.JSX.Element {
  const route = useSessionStore((s) => s.route);

  useEffect(() => {
    marketController.start();
    return () => marketController.stop();
  }, []);

  // cold start = getInitialURL, warm start = 'url' event. need both.
  useEffect(() => {
    const handleUrl = (url: string | null | undefined): void => {
      const next = routeFromDeepLink(url);
      if (!next) return;
      useSessionStore.getState().openDetail(next.symbol);
    };

    void Linking.getInitialURL().then(handleUrl);
    const subscription = Linking.addEventListener('url', (event) => handleUrl(event.url));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (useSessionStore.getState().route.name === 'detail') {
        useSessionStore.getState().goWatchlist();
        return true;
      }
      // Returning false no longer finishes the activity on current Android / RN,
      // because registering this listener claims the system back callback.
      BackHandler.exitApp();
      return true;
    });
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        {route.name === 'watchlist' ? (
          <WatchlistScreen />
        ) : isLiveSymbol(route.symbol) ? (
          <TradingScreen onBack={() => useSessionStore.getState().goWatchlist()} />
        ) : (
          <CatalogDetailScreen symbol={route.symbol} />
        )}
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
