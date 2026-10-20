import { StyleSheet, Text, View } from 'react-native';
import type { PendingAction, ProjectState } from '../api/types';
import { confirmationCost } from '../lib/transparency';
import { colors, space, type as typography } from '../theme';

export function CostEstimate({ state, action }: { state?: ProjectState; action: PendingAction['type'] }) {
  const cost = confirmationCost(state, action);
  if (!cost) return null;
  return <View style={styles.container}>
    <Text testID={`cost-estimate-${action}`} style={styles.estimate}>{cost.label}</Text>
    {cost.insufficient ? <Text testID={`budget-insufficient-${action}`} accessibilityRole="alert" style={styles.insufficient}>今日余额不足，暂时无法生成。请明天再试或调整预算。</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  container: { gap: space.xs, marginBottom: space.md },
  estimate: { ...typography.caption, color: colors.muted },
  insufficient: { ...typography.caption, color: colors.danger },
});
