import { View, useWindowDimensions } from 'react-native';

import { layout, radius, space } from '../../theme';
import { Skeleton } from './Skeleton';

export interface LoadingSkeletonProps {
  /** 骨架布局类型，默认 list。 */
  kind?: 'list' | 'workspace' | 'note';
}

export function LoadingSkeleton({ kind = 'list' }: LoadingSkeletonProps) {
  const { width } = useWindowDimensions();
  const coverHeight = (Math.min(width, layout.maxWidth) - space.lg * 2) / layout.thumbnailRatio;
  return <View accessibilityLabel="正在加载内容" accessibilityRole="progressbar" style={{ padding: space.lg, gap: space.xl }}>
    {kind === 'note' ? <><Skeleton style={{ width: '100%', height: coverHeight, borderRadius: radius.lg }} /><Skeleton style={{ width: '75%', height: 28 }} /><Skeleton /><Skeleton style={{ width: '85%' }} /></> : kind === 'workspace' ? <><Skeleton style={{ width: '65%', height: 48 }} /><Skeleton style={{ width: '90%', height: 100 }} /><Skeleton style={{ height: 240, borderRadius: radius.lg }} /></> : [0, 1].map(item => <View key={item} style={{ flexDirection: 'row', gap: space.lg }}><Skeleton style={{ width: 80, height: 104 }} /><View style={{ flex: 1, gap: space.md, paddingTop: space.sm }}><Skeleton style={{ width: '35%' }} /><Skeleton style={{ width: '90%', height: 24 }} /><Skeleton style={{ width: '65%' }} /></View></View>)}
  </View>;
}
