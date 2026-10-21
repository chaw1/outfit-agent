import { StyleSheet } from 'react-native';

import { colors, layout, radius, space, type } from '../../theme';

export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surface, width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center' },
  content: { padding: space.xl, paddingBottom: space.xxl, gap: space.xl },
  title: { ...type.title, color: colors.ink },
  subtitle: { ...type.body, color: colors.muted },
  label: { ...type.label, color: colors.ink, marginBottom: space.sm },
  input: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.paper, borderRadius: radius.sm, paddingHorizontal: space.lg, paddingVertical: space.md, ...type.body, color: colors.ink, minHeight: 52, outlineColor: colors.redText },
  section: { ...type.heading, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
