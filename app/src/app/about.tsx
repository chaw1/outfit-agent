import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { AnimatedEntry, Header, Page, styles } from '../components/ui';
import { useSession } from '../context/Session';
import { colors, radius, space, type } from '../theme';

export default function About() {
  const router = useRouter();
  const { baseUrl, token } = useSession();
  return <Page>
    <Header title="关于衣序" onBack={() => router.canGoBack() ? router.back() : router.replace(token ? '/' : '/login')} />
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
      <AnimatedEntry style={localStyles.brand}>
        <View style={localStyles.logo}><Ionicons name="shirt-outline" size={40} color={colors.white} /></View>
        <Text style={styles.title}>衣序 OUTFIT NOTES</Text>
        <Text testID="app-version" style={styles.subtitle}>版本 {Constants.expoConfig?.version ?? '1.0.0'}</Text>
      </AnimatedEntry>
      <View style={localStyles.section}>
        <Text style={styles.section}>服务地址</Text>
        <View style={localStyles.service}><Ionicons name="server-outline" size={18} color={colors.muted} /><Text selectable style={[styles.subtitle, { flex: 1 }]}>{baseUrl}</Text></View>
      </View>
      <View style={localStyles.section}>
        <Text style={styles.section}>隐私说明</Text>
        <Text style={styles.subtitle}>你选择的照片、形象档案、合作需求和对话会上传到上方配置的服务，用于生成穿搭内容。生成请求可能由该服务交给模型提供方处理，请只上传你有权使用的内容。</Text>
        <Text style={styles.subtitle}>登录凭证在本机安全存储；网页版登录状态随会话保存。本人照片预览和引导状态保存在本机。删除项目会请求清理项目生成内容，上传原图可能被其他项目复用而保留。修改或删除档案照片不会自动删除项目内使用的原图。</Text>
        <Text style={styles.subtitle}>本地通知只用于生成结果，不接入推送平台；拒绝授权仍可在项目里查看结果。手机系统可能延后后台检查，重新打开应用也会同步。</Text>
      </View>
      <View style={localStyles.disclosure}><Ionicons name="sparkles-outline" size={18} color={colors.redText} /><Text style={localStyles.disclosureText}>发布时请检查内容，并在目标平台勾选 AI 内容声明。</Text></View>
    </ScrollView>
  </Page>;
}

const localStyles = StyleSheet.create({
  brand: { gap: space.sm, alignItems: 'center', paddingVertical: space.xl },
  logo: { width: 80, height: 80, backgroundColor: colors.red, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', marginBottom: space.md },
  section: { gap: space.lg, paddingTop: space.xl, borderTopWidth: 1, borderTopColor: colors.border },
  service: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: colors.paper, padding: space.lg, borderRadius: radius.md },
  disclosure: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, padding: space.lg, borderRadius: radius.md, backgroundColor: colors.blush },
  disclosureText: { ...type.caption, color: colors.redText, flex: 1 },
});
