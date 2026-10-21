import { View } from 'react-native';

import { space } from '../../theme';
import { ProgressStrip } from './ProgressStrip';

export interface LoadingProps {
  /** 加载提示，默认“稍等一下…”。 */
  text?: string;
}

export function Loading({ text = '稍等一下…' }: LoadingProps) {
  return <View style={{ padding: space.xl }}><ProgressStrip title={text} /></View>;
}
