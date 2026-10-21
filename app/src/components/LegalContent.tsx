import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { LegalDocument, LegalKind } from '../api/types';
import { useSession } from '../context/Session';
import { colors, space, type } from '../theme';
import { LoadingSkeleton, Notice, errorText, styles } from './ui';

export function LegalContent({ kind }: { kind: LegalKind }) {
  const { api } = useSession();
  const [document, setDocument] = useState<LegalDocument | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    api.legalDocument(kind).then(value => { if (alive) setDocument(value); }).catch(e => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [api, kind, retry]);
  if (error) return <Notice text={error} onRetry={() => { setDocument(null); setError(''); setRetry(value => value + 1); }} />;
  if (!document) return <LoadingSkeleton kind="list" />;
  return <View testID={`legal-${kind}`} style={{ gap: space.lg }}>
    <Text style={styles.subtitle}>版本 {document.version} · 衣序（演示版）</Text>
    {document.markdown.split(/\n\s*\n/).filter(Boolean).map((block, index) => {
      const heading = block.match(/^#{1,6}\s+(.+)$/);
      if (heading) return <Text key={index} accessibilityRole="header" style={styles.section}>{heading[1]}</Text>;
      return <Text selectable key={index} style={{ ...type.reading, color: colors.ink }}>{block.replace(/^[-*]\s+/gm, '• ')}</Text>;
    })}
  </View>;
}
