import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView } from 'react-native';
import type { LegalKind } from '../../api/types';
import { LegalContent } from '../../components/LegalContent';
import { legalTitles } from '../../components/LegalLinks';
import { Header, Notice, Page, styles } from '../../components/ui';

export default function LegalPage() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  const router = useRouter();
  const valid = Object.hasOwn(legalTitles, kind);
  return <Page>
    <Header title={valid ? legalTitles[kind as LegalKind] : '法律文本'} onBack={() => router.canGoBack() ? router.back() : router.replace('/login')} />
    <ScrollView contentContainerStyle={styles.content}>{valid ? <LegalContent key={kind} kind={kind as LegalKind} /> : <Notice text="没有这份法律文本，请从协议入口重新打开。" />}</ScrollView>
  </Page>;
}
