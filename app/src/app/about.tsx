import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';
import { Header, Page, colors, styles } from '../components/ui';
import { useSession } from '../context/Session';

export default function About() {
  const router = useRouter();
  const { baseUrl, token } = useSession();
  return <Page scroll><Header title="关于衣序" onBack={() => router.canGoBack() ? router.back() : router.replace(token ? '/' : '/login')} /><View style={{ gap: 20 }}>
    <Text style={styles.title}>衣序 OUTFIT NOTES</Text><Text testID="app-version" style={styles.subtitle}>版本 {Constants.expoConfig?.version ?? '1.0.0'}</Text>
    <Text style={styles.section}>服务地址</Text><Text selectable style={styles.subtitle}>{baseUrl}</Text>
    <Text style={styles.section}>隐私说明</Text><Text style={styles.subtitle}>你选择的照片、形象档案、合作需求和对话会上传到上方配置的服务，用于生成穿搭内容。生成请求可能由该服务交给模型提供方处理，请只上传你有权使用的内容。</Text>
    <Text style={styles.subtitle}>登录凭证在本机安全存储；网页版登录状态随会话保存。本人照片预览和引导状态保存在本机。删除项目会请求清理项目生成内容，上传原图可能被其他项目复用而保留。修改或删除档案照片不会自动删除项目内使用的原图。</Text>
    <Text style={styles.subtitle}>本地通知只用于生成结果，不接入推送平台；拒绝授权仍可在项目里查看结果。手机系统可能延后后台检查，重新打开应用也会同步。</Text>
    <Text style={{ color: colors.red, lineHeight: 22 }}>发布时请检查内容，并在目标平台勾选 AI 内容声明。</Text>
  </View></Page>;
}
