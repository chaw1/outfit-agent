import { useState, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import {
  AnimatedEntry,
  Badge,
  Button,
  Card,
  Chip,
  FadeImage,
  Field,
  Header,
  IconButton,
  Loading,
  LoadingSkeleton,
  Notice,
  Page,
  ProgressStrip,
  Segmented,
  Sheet,
  Skeleton,
  StatePanel,
  ThemeProvider,
  Toast,
  usePalette,
  useTypography,
  type ButtonProps,
  type ThemeTone,
} from '../components/ds';
import { layout, radius, space } from '../theme';

type WidthOption = '320' | '390';
type ScaleOption = '1.0' | '1.3';
const doNothing = () => undefined;
const buttonVariants = ['primary', 'secondary', 'ghost', 'danger'] as const;
const buttonStates = ['default', 'pressed', 'disabled', 'loading'] as const;
const badgeTones = ['brand', 'success', 'neutral', 'warning', 'danger', 'inverse'] as const;
const loadingKinds = ['list', 'workspace', 'note'] as const;

interface GalleryTextProps {
  /** 规格说明或示例文字。 */
  children: ReactNode;
  /** 字体层级，来自当前主题与字号倍率。 */
  kind?: 'heading' | 'subtitle' | 'body' | 'caption' | 'badge';
  /** 文字语义色。 */
  tone?: 'ink' | 'muted' | 'brand';
}

function GalleryText({ children, kind = 'body', tone = 'ink' }: GalleryTextProps) {
  const palette = usePalette();
  const type = useTypography();
  return <Text style={{ ...type[kind], color: tone === 'brand' ? palette.redText : palette[tone] }}>{children}</Text>;
}

interface SectionProps {
  /** 规格页中的分组编号。 */
  number: string;
  /** 组件名称。 */
  title: string;
  /** 当前分组覆盖的变体与状态。 */
  summary: string;
  /** 组件实例。 */
  children: ReactNode;
}

function Section({ number, title, summary, children }: SectionProps) {
  const palette = usePalette();
  const type = useTypography();
  return <View style={{ gap: space.lg }}>
    <View style={{ gap: space.xs, paddingTop: space.lg, borderTopWidth: 1, borderTopColor: palette.border }}>
      <GalleryText kind="badge" tone="brand">{number} / COMPONENT</GalleryText>
      <Text accessibilityRole="header" style={{ ...type.heading, color: palette.ink }}>{title}</Text>
      <GalleryText kind="caption" tone="muted">{summary}</GalleryText>
    </View>
    {children}
  </View>;
}

interface ButtonExampleProps {
  /** 被展示的按钮变体。 */
  variant: NonNullable<ButtonProps['variant']>;
  /** 固定展示的交互状态。 */
  state: typeof buttonStates[number];
}

function ButtonExample({ variant, state }: ButtonExampleProps) {
  return <View style={{ gap: space.xs }}>
    <GalleryText kind="caption" tone="muted">{state}</GalleryText>
    <Button
      title="开始创作"
      variant={variant}
      previewPressed={state === 'pressed'}
      disabled={state === 'disabled'}
      loading={state === 'loading'}
      icon="sparkles-outline"
      testID={`design-button-${variant}-${state}`}
      onPress={doNothing}
    />
  </View>;
}

interface GallerySurfaceProps {
  /** 当前预览主题。 */
  tone: ThemeTone;
  /** 当前预览宽度。 */
  width: WidthOption;
  /** 当前字号倍率。 */
  scale: ScaleOption;
  /** 更新预览主题。 */
  onTone: (value: ThemeTone) => void;
  /** 更新预览宽度。 */
  onWidth: (value: WidthOption) => void;
  /** 更新字号倍率。 */
  onScale: (value: ScaleOption) => void;
}

function GallerySurface({ tone, width, scale, onTone, onWidth, onScale }: GallerySurfaceProps) {
  const palette = usePalette();
  const type = useTypography();
  const [sheetVisible, setSheetVisible] = useState(false);
  const [sampleMode, setSampleMode] = useState<'auto' | 'guided'>('guided');
  return <View testID="YIXU_DS_GALLERY_ONLY" style={{ flex: 1, backgroundColor: palette.paper }}>
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ alignItems: 'center', paddingVertical: space.xl, gap: space.xl }}
    >
      <View style={{ width: '100%', maxWidth: 760, paddingHorizontal: space.lg, gap: space.xl }}>
        <View style={{ gap: space.sm }}>
          <GalleryText kind="badge" tone="brand">YIXU DESIGN SYSTEM / DEVELOPMENT</GalleryText>
          <Text accessibilityRole="header" style={{ ...type.title, color: palette.ink }}>衣序 DS</Text>
          <GalleryText tone="muted">片场是暗的，编辑桌是亮的。</GalleryText>
          <GalleryText kind="caption" tone="muted">组件规格、交互状态与回归截图，在同一处检查。</GalleryText>
        </View>
        <Card>
          <GalleryText kind="subtitle">预览设置</GalleryText>
          <View style={{ gap: space.sm }}>
            <GalleryText kind="caption" tone="muted">主题 / THEME</GalleryText>
            <Segmented label="主题" value={tone} options={[{ value: 'paper', label: 'paper' }, { value: 'studio', label: 'studio' }]} onChange={onTone} />
          </View>
          <View style={{ gap: space.sm }}>
            <GalleryText kind="caption" tone="muted">宽度 / VIEWPORT</GalleryText>
            <Segmented label="宽度" value={width} options={[{ value: '320', label: '320' }, { value: '390', label: '390' }]} onChange={onWidth} />
          </View>
          <View style={{ gap: space.sm }}>
            <GalleryText kind="caption" tone="muted">字号 / FONT SCALE</GalleryText>
            <Segmented label="字号" value={scale} options={[{ value: '1.0', label: '1.0' }, { value: '1.3', label: '1.3' }]} onChange={onScale} />
          </View>
          <GalleryText kind="caption" tone="muted">{`${tone} · ${width} px · 字号 ${scale} 倍`}</GalleryText>
        </Card>
      </View>

      <View
        testID="design-content"
        style={{ width: Number(width), padding: space.lg, gap: space.xxl, backgroundColor: palette.paper, borderWidth: 1, borderColor: palette.border, borderRadius: radius.lg }}
      >
        <View style={{ gap: space.sm }}>
          <GalleryText kind="badge" tone="brand">FOUNDATIONS → COMPONENTS</GalleryText>
          <GalleryText kind="heading">每一种状态，都有依据</GalleryText>
          <GalleryText kind="caption" tone="muted">以下示例共享相同的 token、主题和字体倍率。交互控件的触控区域至少为 44 × 44。</GalleryText>
        </View>

        <Section number="01" title="Button" summary="4 种变体 × default / pressed / disabled / loading">
          {buttonVariants.map(variant => <Card key={variant}>
            <GalleryText kind="subtitle">{variant}</GalleryText>
            {buttonStates.map(state => <ButtonExample key={state} variant={variant} state={state} />)}
          </Card>)}
        </Section>

        <Section number="02" title="Field" summary="default / focused / error / disabled；标签始终可见">
          <Field label="default · 项目名称" placeholder="给这组片起个名字" testID="design-field-default" />
          <Field label="focused · 拍摄灵感" value="咖啡馆午后的自然光" previewFocused onChangeText={doNothing} testID="design-field-focused" />
          <Field label="error · 创作描述" placeholder="写一点拍摄想法" error="写一点想拍什么，再继续创作。" testID="design-field-error" />
          <Field label="disabled · 项目编号" value="YIXU-001" disabled testID="design-field-disabled" />
        </Section>

        <Section number="03" title="Badge" summary="brand / success / neutral / warning；兼容 danger / inverse">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {badgeTones.map(badgeTone => <Badge key={badgeTone} label={badgeTone} tone={badgeTone} />)}
          </View>
        </Section>

        <Section number="04" title="StatePanel" summary="empty / error / offline；每个状态提供恢复方向">
          <StatePanel variant="empty" icon="shirt-outline" title="下一组灵感，从这里开始" description="带上一件衣服，为这次创作找一个方向。" actionLabel="添加衣服" onAction={doNothing} />
          <StatePanel variant="error" icon="alert-circle-outline" title="图片这次没能保存" description="已经生成的内容仍然保留，可以再试一次。" actionLabel="重新保存" onAction={doNothing} />
          <StatePanel variant="offline" icon="cloud-offline-outline" title="连接暂时中断" description="恢复连接后，继续刚才的创作。" actionLabel="重新连接" onAction={doNothing} />
        </Section>

        <Section number="05" title="Card" summary="surface / inset；同一套内容层级，不同的表面强调">
          <Card variant="surface"><GalleryText kind="subtitle">surface · 标准表面</GalleryText><GalleryText kind="caption" tone="muted">承载一组需要一起理解的信息。</GalleryText><Badge label="独立内容" tone="brand" /></Card>
          <Card variant="inset"><GalleryText kind="subtitle">inset · 内嵌表面</GalleryText><GalleryText kind="caption" tone="muted">为补充信息建立较轻的视觉层级。</GalleryText><Badge label="补充说明" /></Card>
        </Section>

        <Section number="06" title="Chip" summary="default / selected / disabled；用于风格词条多选">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            <Chip label="松弛通勤" onPress={doNothing} />
            <Chip label="法式慵懒" selected onPress={doNothing} />
            <Chip label="复古港风" disabled onPress={doNothing} />
          </View>
        </Section>

        <Section number="07" title="Segmented" summary="selected / disabled；模式之间互斥选择">
          <GalleryText kind="caption" tone="muted">selected · 可切换</GalleryText>
          <Segmented label="示例创作模式" value={sampleMode} options={[{ value: 'auto', label: '一键出片' }, { value: 'guided', label: '沉浸编导' }]} onChange={setSampleMode} />
          <GalleryText kind="caption" tone="muted">disabled · 选项暂不可用</GalleryText>
          <Segmented label="禁用选项示例" value="guided" options={[{ value: 'auto', label: '一键出片', disabled: true }, { value: 'guided', label: '沉浸编导' }]} onChange={doNothing} />
        </Section>

        <Section number="08" title="Sheet" summary="内嵌表面预览 / 真实底部弹层；系统返回与遮罩均可关闭">
          <View style={{ backgroundColor: palette.blush, padding: space.sm, borderRadius: radius.lg }}>
            <Sheet label="片场操作" visible inline onClose={doNothing}>
              <GalleryText>这里展示与真实弹层相同的表面。</GalleryText>
              <GalleryText kind="caption" tone="muted">标题、关闭按钮、内容和安全区共同组成底部弹层。</GalleryText>
              <Button title="保留这份灵感" variant="secondary" onPress={doNothing} />
            </Sheet>
          </View>
          <Button title="打开真实 Sheet" variant="secondary" onPress={() => setSheetVisible(true)} testID="design-open-sheet" />
        </Section>

        <Section number="09" title="Page / Header / IconButton" summary="安全区页面 / 返回与标题 / 右侧操作；图标按钮必须提供名称">
          <Card style={{ padding: space.xs }}><View style={{ height: scale === '1.3' ? 260 : 196 }}><Page tone={tone}><Header title="这次，我们这样拍" subtitle="一个标题，一条必要的说明" onBack={doNothing} right={<IconButton name="ellipsis-horizontal" label="更多片场操作" onPress={doNothing} />} /><View style={{ padding: space.lg, gap: space.sm }}><GalleryText kind="subtitle">Page</GalleryText><GalleryText kind="caption" tone="muted">安全区与页头，构成清晰的页面起点。</GalleryText></View></Page></View></Card>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            <IconButton name="arrow-back" label="返回示例" onPress={doNothing} />
            <IconButton name="heart-outline" label="收藏示例" onPress={doNothing} />
            <IconButton name="close" label="关闭示例" onPress={doNothing} />
          </View>
        </Section>

        <Section number="10" title="Notice / Toast" summary="可恢复提示与重试；success / danger / info 临时反馈">
          <Notice text="这次没能连接上，内容已经保留。" onRetry={doNothing} />
          <Notice text="先取到这次的估点，再继续创作。" />
          <Toast text="success · 灵感已经保存。" tone="success" duration={0} testID="design-toast-success" />
          <Toast text="danger · 图片没传好，可以重试。" tone="danger" duration={0} testID="design-toast-danger" />
          <Toast text="info · 这次的创作会保留每个版本。" tone="info" duration={0} testID="design-toast-info" />
        </Section>

        <Section number="11" title="AnimatedEntry / FadeImage" summary="内容渐入 / 本地图片淡入；入场与加载动效遵循系统减少动态效果设置">
          <AnimatedEntry><Card><GalleryText kind="subtitle">AnimatedEntry</GalleryText><GalleryText kind="caption" tone="muted">用轻量入场表达内容已准备好。</GalleryText></Card></AnimatedEntry>
          <FadeImage source={require('../../assets/inspiration/studio-01.jpg')} accessibilityLabel="松弛通勤本地灵感样片" resizeMode="cover" testID="design-local-image" style={{ width: '100%', height: 216, borderRadius: radius.md, backgroundColor: palette.placeholder }} />
          <GalleryText kind="caption" tone="muted">FadeImage · 使用仓库内的静态样片，无远程图片请求。</GalleryText>
        </Section>

        <Section number="12" title="Skeleton / LoadingSkeleton" summary="基础骨架 / list / workspace / note；加载状态保留内容结构">
          <Card><GalleryText kind="subtitle">Skeleton</GalleryText><Skeleton width="100%" height={space.lg} /><Skeleton width="75%" height={space.xl} /><Skeleton width="50%" height={space.lg} /></Card>
          {loadingKinds.map(kind => <View key={kind} style={{ gap: space.sm }}><GalleryText kind="caption" tone="muted">{`LoadingSkeleton / ${kind}`}</GalleryText><Card style={{ padding: space.xs }}><LoadingSkeleton kind={kind} /></Card></View>)}
        </Section>

        <Section number="13" title="ProgressStrip / Loading" summary="标题 / 补充说明 / 进度；始终说明正在发生什么">
          <ProgressStrip title="正在准备这组画面" detail="完成后会出现在这里，每个版本都会保留。" />
          <ProgressStrip title="正在整理灵感" />
          <Card style={{ padding: space.xs }}><Loading text="稍等一下，画面正在准备…" /></Card>
        </Section>

        <View style={{ borderTopWidth: 1, borderTopColor: palette.border, paddingTop: space.lg, gap: space.sm }}>
          <GalleryText kind="badge" tone="brand">DESIGN → TOKENS → COMPONENTS → SNAPSHOTS</GalleryText>
          <GalleryText kind="caption" tone="muted">这是一份开发构建中的组件规格页，仅通过开发 URL 访问。</GalleryText>
          <GalleryText kind="caption" tone="muted">{`预览宽度 ${width} px · 最小触控 ${layout.touch} px · 字号倍率 ${scale}`}</GalleryText>
        </View>
      </View>
    </ScrollView>
    <Sheet label="片场操作演示" visible={sheetVisible} onClose={() => setSheetVisible(false)}>
      <GalleryText>真实弹层支持关闭按钮、遮罩和系统返回。</GalleryText>
      <GalleryText kind="caption" tone="muted">这次操作只影响组件示例。</GalleryText>
      <Button title="完成并关闭" onPress={() => setSheetVisible(false)} testID="design-close-sheet" />
    </Sheet>
  </View>;
}

export default function Gallery() {
  const [tone, setTone] = useState<ThemeTone>('paper');
  const [width, setWidth] = useState<WidthOption>('390');
  const [scale, setScale] = useState<ScaleOption>('1.0');
  return <ThemeProvider tone={tone} fontScale={Number(scale)}><GallerySurface tone={tone} width={width} scale={scale} onTone={setTone} onWidth={setWidth} onScale={setScale} /></ThemeProvider>;
}
