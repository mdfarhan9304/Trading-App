import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

interface Props {
  label?: string;
  onPress(): void;
}

export const BackButton: React.FC<Props> = ({ label = 'WATCHLIST', onPress }) => (
  <Pressable
    onPress={onPress}
    style={styles.row}
    hitSlop={8}
    accessibilityRole="button"
    accessibilityLabel={`Back to ${label}`}
  >
    <View style={styles.icon}>
      <View style={styles.chevron} />
    </View>
    <Text style={styles.label}>{label}</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    marginLeft: -theme.space(1),
    marginBottom: theme.space(1),
  },
  icon: {
    width: 28,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevron: {
    width: 14,
    height: 14,
    borderLeftWidth: 2.5,
    borderBottomWidth: 2.5,
    borderColor: theme.color.accent,
    transform: [{ rotate: '45deg' }],
    marginLeft: 6,
  },
  label: {
    color: theme.color.accent,
    fontSize: theme.font.size.md,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
