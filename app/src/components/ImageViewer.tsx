import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeInDown, ReduceMotion, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, ClipPath, Defs, G, Polyline, Rect } from 'react-native-svg';
import type { Action, ImageRegion, OutfitImage, PendingAction, Stage } from '../api/types';
import { prepareEditSubmission, rejectedResult, reusedResult, type EditSubmission } from '../lib/editAttempt';
import { feedback } from '../lib/haptics';
import { clamp, constrainTransform, containRect, editActionForResult, IDENTITY_TRANSFORM, imageVersionFamily, regionFromPoints, screenToImage, zoomAtPoint, type ImageTransform, type Point, type Size } from '../lib/imageGeometry';
import { colors, layout, motion, radius, space, type as typography } from '../theme';
import { FidelityBadge } from './GenerationInfo';
import { Badge, FadeImage, ProgressStrip } from './ui';

export type ViewerMode = 'view' | 'local' | 'whole' | 'compare';
type DrawingTool = 'brush' | 'rectangle' | 'pan';
type EditAction = Extract<Action, { type: 'edit_image' }>;
export interface ImageViewerProps {
  images: OutfitImage[];
  editActions?: EditAction[];
  initialImageId: string;
  initialMode?: ViewerMode;
  busy?: boolean;
  canEdit?: boolean;
  stage?: Stage;
  pendingAction?: PendingAction | null;
  adoptedImageIds?: string[];
  onAdopt?: (image: OutfitImage) => Promise<unknown>;
  confirmationOverlay?: ReactNode;
  onDismissConfirmation?: () => void;
  onClose: () => void;
  onAction: (action: Action) => Promise<unknown> | void;
  onReference: (image: OutfitImage) => void;
}

const QUICK_EDITS = ['袖口放下来', '衬衫塞进裤腰', '去掉吊牌', '换个颜色', '背景亮一点', '自己输入'];
const EMPTY_SIZE = { width: 0, height: 0 };

function ToolButton({ title, icon, testID, onPress, selected, disabled }: { title: string; icon?: React.ComponentProps<typeof Ionicons>['name']; testID: string; onPress: () => void; selected?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ selected, disabled: Boolean(disabled) }} testID={testID} onPress={onPress} disabled={disabled} style={({ pressed }) => [styles.toolButton, selected && styles.toolSelected, disabled && styles.disabled, pressed && styles.pressed]}>
    {icon ? <Ionicons name={icon} size={18} color={selected ? colors.white : colors.viewerMuted} /> : null}<Text style={[styles.toolText, selected && styles.selectedText]}>{title}</Text>
  </Pressable>;
}

/** The same gesture-backed slider works with a finger, a mouse, and accessibility actions. */
function TrackSlider({ value, min = 0, max = 1, label, testID, onChange }: { value: number; min?: number; max?: number; label: string; testID: string; onChange: (value: number) => void }) {
  const width = useRef(1);
  const props = useRef({ onChange, min, max });
  useLayoutEffect(() => { props.current = { onChange, min, max }; }, [onChange, min, max]);
  /* eslint-disable react-hooks/refs -- Gesture builders register these callbacks; they run only after user input. */
  const gesture = useMemo(() => Gesture.Pan().minDistance(0).runOnJS(true)
    .onBegin(event => props.current.onChange(props.current.min + clamp(event.x / width.current, 0, 1) * (props.current.max - props.current.min)))
    .onUpdate(event => props.current.onChange(props.current.min + clamp(event.x / width.current, 0, 1) * (props.current.max - props.current.min))), []);
  /* eslint-enable react-hooks/refs */
  const percentage = clamp((value - min) / (max - min), 0, 1) * 100;
  return <GestureDetector gesture={gesture}><View testID={testID} accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ min, max, now: value }} accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={event => onChange(clamp(value + (event.nativeEvent.actionName === 'increment' ? 1 : -1) * (max - min) / 10, min, max))} onLayout={event => { width.current = event.nativeEvent.layout.width || 1; }} style={styles.slider}>
    <View pointerEvents="none" style={styles.sliderTrack}><View style={[styles.sliderFill, { width: `${percentage}%` }]} /></View><View pointerEvents="none" style={[styles.sliderKnob, { left: `${percentage}%` }]} />
  </View></GestureDetector>;
}

export function ImageViewer({ images, editActions = [], initialImageId, initialMode = 'view', busy = false, canEdit = true, stage, pendingAction, adoptedImageIds = [], onAdopt, confirmationOverlay, onDismissConfirmation, onClose, onAction, onReference }: ImageViewerProps) {
  const [currentId, setCurrentId] = useState(initialImageId);
  const [mode, setMode] = useState<ViewerMode>(canEdit ? initialMode : initialMode === 'local' || initialMode === 'whole' ? 'view' : initialMode);
  const [tool, setTool] = useState<DrawingTool>('brush');
  const [selectionTool, setSelectionTool] = useState<'brush' | 'rectangle'>('brush');
  const [viewport, setViewport] = useState<Size>(EMPTY_SIZE);
  const [imageSize, setImageSize] = useState<Size>(EMPTY_SIZE);
  const [transform, setTransformState] = useState<ImageTransform>(IDENTITY_TRANSFORM);
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [region, setRegion] = useState<ImageRegion | null>(null);
  const [brush, setBrush] = useState(.075);
  const [instruction, setInstruction] = useState('');
  const [compare, setCompare] = useState(.5);
  const [error, setError] = useState<string>();
  const [failedUrl, setFailedUrl] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [reusedNotice, setReusedNotice] = useState('');
  const [keyboardVisible, setKeyboardVisible] = useState(() => Platform.OS !== 'web' && Keyboard.isVisible());
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const [pending, setPending] = useState<{ parentId: string; knownIds: Set<string>; action: EditAction; reuseSnapshot?: PendingAction | null } | null>(null);
  const resultActions = useRef(new Map<string, EditAction>());
  const transportRetry = useRef<EditSubmission | undefined>(undefined);
  const input = useRef<TextInputInstance>(null);
  const versionsScroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const versionLayouts = useRef(new Map<string, { x: number; width: number }>());
  const current = images.find(image => image.id === currentId) ?? images.find(image => image.id === initialImageId) ?? images[0];
  const available = images.filter(image => image.status === 'succeeded' && image.url);
  const currentIndex = available.findIndex(image => image.id === current?.id);
  const shotNumber = [...new Set(images.map(image => image.shot_id))].indexOf(current?.shot_id ?? '') + 1;
  const family = useMemo(() => current ? imageVersionFamily(images, current.id) : [], [images, current]);
  const parent = images.find(image => image.id === current?.parent_id && image.status === 'succeeded' && image.url);
  const rect = useMemo(() => containRect(imageSize, viewport), [imageSize, viewport]);
  const localEditing = mode === 'local';
  const editing = localEditing || mode === 'whole';
  const compactKeyboard = editing && keyboardVisible;
  const comparing = mode === 'compare' && Boolean(parent?.url);
  const pendingImage = pending ? images.find(image => image.parent_id === pending.parentId && !pending.knownIds.has(image.id)) : undefined;
  const generationBusy = submitting || Boolean(pending) || busy;
  const suggestionContext = mode === 'whole' ? '整体氛围：可试试背景和颜色' : selectionTool === 'rectangle' ? '大块区域：可试试换色或提亮背景' : '衣服细节：可试试袖口、裤腰和吊牌';
  const recommendedEdits = mode === 'whole' ? [4, 3] : selectionTool === 'rectangle' ? [3, 4] : [0, 1, 2];
  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const imageStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }] }));
  const transformRef = useRef<ImageTransform>(IDENTITY_TRANSFORM);
  const strokeRef = useRef<Point[][]>([]);
  const regionStart = useRef<Point | null>(null);
  const drawActive = useRef(false);
  const pinchActive = useRef(false);
  const panStart = useRef<ImageTransform>(IDENTITY_TRANSFORM);
  const pinchStart = useRef<ImageTransform>(IDENTITY_TRANSFORM);
  const pinchFocal = useRef<Point>({ x: 0, y: 0 });
  const selectionBeforeGesture = useRef<{ strokes: Point[][]; region: ImageRegion | null } | null>(null);
  const unfinishedDrawing = useRef(false);
  const context = useRef({ mode, tool, rect, viewport, available, region, currentId: current?.id, canDraw: false });
  useLayoutEffect(() => {
    context.current = { mode, tool, rect, viewport, available, region, currentId: current?.id, canDraw: Boolean(rect && !generationBusy && canEdit && current?.url && failedUrl !== current?.url) };
  }, [mode, tool, rect, viewport, available, region, current?.id, current?.url, generationBusy, canEdit, failedUrl]);

  const setTransform = useCallback((next: ImageTransform) => {
    transformRef.current = next;
    scale.set(next.scale);
    translateX.set(next.translateX);
    translateY.set(next.translateY);
    setTransformState(next);
  }, [scale, translateX, translateY]);

  const clearSelection = useCallback(() => {
    strokeRef.current = [];
    setStrokes([]);
    regionStart.current = null;
    setRegion(null);
  }, []);

  const resetForImage = useCallback((id: string, restored?: EditAction) => {
    setCurrentId(id);
    setTransform(IDENTITY_TRANSFORM);
    clearSelection();
    if (restored?.mask_strokes) {
      strokeRef.current = restored.mask_strokes.strokes.map(stroke => stroke.map(point => ({ ...point })));
      setStrokes(strokeRef.current);
      setBrush(restored.mask_strokes.brush);
    }
    if (restored?.region) setRegion({ ...restored.region });
    if (id !== context.current.currentId) setImageSize(EMPTY_SIZE);
    setFailedUrl(undefined);
    setError(undefined);
  }, [clearSelection, setTransform]);

  const selectImage = useCallback((id: string) => {
    resetForImage(id);
    setMode('view');
    feedback();
  }, [resetForImage]);

  const selectAdjacent = useCallback((direction: number) => {
    const state = context.current;
    const index = state.available.findIndex(image => image.id === state.currentId);
    const next = state.available[index + direction];
    if (next) selectImage(next.id);
  }, [selectImage]);

  /* eslint-disable react-hooks/set-state-in-effect -- Polling delivers external job completion; synchronize the viewer once with that result. */
  useEffect(() => {
    let alive = true;
    if (current?.url) Image.getSize(current.url, (width, height) => {
      if (alive) {
        setImageSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
        setFailedUrl(undefined);
      }
    }, () => { if (alive) setFailedUrl(current.url); });
    return () => { alive = false; };
  }, [current?.id, current?.url]);

  useEffect(() => {
    if (rect) setTransform(constrainTransform(transformRef.current, rect, viewport));
  }, [rect, viewport, setTransform]);

  useEffect(() => {
    const item = versionLayouts.current.get(current?.id ?? '');
    if (item) versionsScroll.current?.scrollTo({ x: Math.max(0, item.x + item.width / 2 - viewport.width / 2), animated: true });
  }, [current?.id, family.length, viewport.width]);

  useEffect(() => {
    if (!pending) return;
    if (!submitting && pendingAction !== pending.reuseSnapshot && pendingAction?.reused === true) {
      setPending(null);
      setReusedNotice('这次和上次一样，没有重新生成');
      return;
    }
    const candidates = images.filter(image => image.parent_id === pending.parentId && !pending.knownIds.has(image.id));
    const completed = candidates.find(image => image.status === 'succeeded' && image.url);
    if (completed) {
      resultActions.current.set(completed.id, pending.action);
      resetForImage(completed.id);
      setMode('compare');
      setCompare(.5);
      setPending(null);
      feedback(completed.edit_check?.passed === false ? 'warning' : 'success');
    } else if (candidates.some(image => image.status === 'failed')) {
      setError(candidates.find(image => image.status === 'failed')?.error || '这一版没生成成功，请重试。');
      setPending(null);
    }
  }, [images, pending, pendingAction, submitting, resetForImage]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/refs -- Gesture builders register these callbacks; they run only after user input. */
  const gestures = useMemo(() => {
    const pan = Gesture.Pan().minDistance(2).maxPointers(1).runOnJS(true)
      .onStart(event => {
        const state = context.current;
        panStart.current = { ...transformRef.current };
        drawActive.current = false;
        unfinishedDrawing.current = false;
        if (state.mode === 'local' && state.tool !== 'pan' && state.canDraw && state.rect && !pinchActive.current) {
          const point = screenToImage({ x: event.x - event.translationX, y: event.y - event.translationY }, state.rect, state.viewport, transformRef.current);
          if (!point) return;
          drawActive.current = true;
          unfinishedDrawing.current = true;
          selectionBeforeGesture.current = { strokes: strokeRef.current, region: state.region };
          regionStart.current = point;
          if (state.tool === 'brush') {
            strokeRef.current = [...strokeRef.current, [point]];
            setStrokes(strokeRef.current);
          } else setRegion(regionFromPoints(point, point));
        }
      })
      .onUpdate(event => {
        const state = context.current;
        if (!state.rect || pinchActive.current) return;
        if (state.mode === 'compare') {
          setCompare(clamp(event.x / state.viewport.width, .02, .98));
        } else if (state.mode === 'local' && state.tool !== 'pan') {
          if (!drawActive.current || !state.canDraw) return;
          const point = screenToImage({ x: event.x, y: event.y }, state.rect, state.viewport, transformRef.current, true);
          if (!point) return;
          if (state.tool === 'brush') {
            const previous = strokeRef.current.at(-1);
            if (!previous) return;
            const last = previous.at(-1)!;
            if (Math.hypot(point.x - last.x, point.y - last.y) < .002 || previous.length >= 1500) return;
            strokeRef.current = [...strokeRef.current.slice(0, -1), [...previous, point]];
            setStrokes(strokeRef.current);
          } else if (regionStart.current) setRegion(regionFromPoints(regionStart.current, point));
        } else if (transformRef.current.scale > 1) {
          setTransform(constrainTransform({ ...panStart.current, translateX: panStart.current.translateX + event.translationX, translateY: panStart.current.translateY + event.translationY }, state.rect, state.viewport));
        }
      })
      .onEnd((event, success) => {
        const state = context.current;
        if (success && state.mode === 'view' && transformRef.current.scale <= 1.01 && Math.abs(event.translationX) > 55 && Math.abs(event.translationX) > Math.abs(event.translationY) * 1.2) selectAdjacent(event.translationX < 0 ? 1 : -1);
        drawActive.current = false;
        if (success) unfinishedDrawing.current = false;
      })
      .onFinalize((_event, success) => {
        if (!success && unfinishedDrawing.current && selectionBeforeGesture.current) {
          strokeRef.current = selectionBeforeGesture.current.strokes;
          setStrokes(strokeRef.current);
          setRegion(selectionBeforeGesture.current.region);
        }
        drawActive.current = false;
        unfinishedDrawing.current = false;
      });
    const pinch = Gesture.Pinch().runOnJS(true)
      .onStart(event => {
        pinchActive.current = true;
        drawActive.current = false;
        if (unfinishedDrawing.current && selectionBeforeGesture.current) {
          strokeRef.current = selectionBeforeGesture.current.strokes;
          setStrokes(strokeRef.current);
          setRegion(selectionBeforeGesture.current.region);
          unfinishedDrawing.current = false;
        }
        pinchStart.current = { ...transformRef.current };
        pinchFocal.current = { x: event.focalX, y: event.focalY };
      })
      .onUpdate(event => {
        const state = context.current;
        if (!state.rect) return;
        const anchored = zoomAtPoint(pinchStart.current, pinchStart.current.scale * event.scale, pinchFocal.current, state.viewport, state.rect);
        setTransform(constrainTransform({ ...anchored, translateX: anchored.translateX + event.focalX - pinchFocal.current.x, translateY: anchored.translateY + event.focalY - pinchFocal.current.y }, state.rect, state.viewport));
      })
      .onFinalize(() => { pinchActive.current = false; });
    const doubleTap = Gesture.Tap().numberOfTaps(2).maxDuration(250).runOnJS(true).onEnd((event, success) => {
      const state = context.current;
      if (success && state.rect && (state.mode !== 'local' || state.tool === 'pan')) {
        const nextScale = transformRef.current.scale > 1.01 ? 1 : 2.5;
        setTransform(zoomAtPoint(transformRef.current, nextScale, { x: event.x, y: event.y }, state.viewport, state.rect));
        feedback();
      }
    });
    const dot = Gesture.Tap().maxDuration(250).runOnJS(true).onEnd((event, success) => {
      const state = context.current;
      if (!success || state.mode !== 'local' || state.tool !== 'brush' || !state.canDraw || !state.rect) return;
      const point = screenToImage({ x: event.x, y: event.y }, state.rect, state.viewport, transformRef.current);
      if (point) { strokeRef.current = [...strokeRef.current, [point]]; setStrokes(strokeRef.current); }
    });
    return Gesture.Simultaneous(Gesture.Race(pan, dot), pinch, doubleTap);
  }, [selectAdjacent, setTransform]);
  /* eslint-enable react-hooks/refs */

  function changeMode(next: ViewerMode) {
    setMode(next);
    setError(undefined);
    if (next === 'compare') setCompare(.5);
    if (next === 'local' || next === 'whole') setInstruction('');
    feedback();
  }

  function zoomBy(factor: number) {
    if (!rect) return;
    setTransform(zoomAtPoint(transformRef.current, transformRef.current.scale * factor, { x: viewport.width / 2, y: viewport.height / 2 }, viewport, rect));
    feedback();
  }

  async function sendEdit(action?: EditAction) {
    if (!current || generationBusy || !canEdit) return;
    let payload = action;
    if (!payload) {
      const text = instruction.trim();
      if (!text) { setError('先说说想怎么改。'); input.current?.focus(); return; }
      if (localEditing && (selectionTool === 'rectangle' ? !region || region.w < .002 || region.h < .002 : !strokes.length)) { setError('先在图片上涂抹或框选要修改的位置。'); return; }
      payload = { type: 'edit_image', image_id: current.id, instruction: text };
      if (localEditing && selectionTool === 'rectangle' && region) payload.region = { ...region };
      else if (localEditing) payload.mask_strokes = { brush, strokes: strokes.map(stroke => stroke.map(point => ({ ...point }))) };
    }
    const submission = prepareEditSubmission(payload, transportRetry.current, Boolean(action));
    payload = submission.action;
    transportRetry.current = submission;
    setSubmitting(true);
    setReusedNotice('');
    setError(undefined);
    const previousMode = mode;
    setMode('view');
    setPending({ parentId: payload.image_id, knownIds: new Set(images.map(image => image.id)), action: payload, reuseSnapshot: pendingAction });
    feedback();
    try {
      const accepted = await onAction(payload);
      if (rejectedResult(accepted)) throw new Error('还没确认服务是否收到，请先刷新项目后再重试。');
      transportRetry.current = undefined;
      if (reusedResult(accepted)) {
        setPending(null);
        setReusedNotice('这次和上次一样，没有重新生成');
      }
    } catch (failure) {
      setPending(null);
      setMode(previousMode);
      setError(failure instanceof Error ? failure.message : '提交失败，请重试。');
      feedback('warning');
    } finally { setSubmitting(false); }
  }

  function retryAction(): EditAction | undefined {
    if (!current?.parent_id || !current.instruction) return undefined;
    const previous = resultActions.current.get(current.id) ?? editActionForResult(images, editActions, current.id);
    if (previous) return { ...previous };
    return { type: 'edit_image', image_id: current.parent_id, instruction: current.instruction, ...(current.region ? { region: { ...current.region } } : {}) };
  }

  function rephrase() {
    transportRetry.current = undefined;
    const previousAction = retryAction();
    const previous = images.find(image => image.id === current?.parent_id);
    if (previous?.url) resetForImage(previous.id, previousAction);
    const local = Boolean(previousAction?.region || previousAction?.mask_strokes);
    setMode(local ? 'local' : 'whole');
    setInstruction(current?.instruction || '');
    setError(undefined);
    // Rephrase against the original pixels while retaining the exact original selection.
    if (local) { const restoredTool = previousAction?.region ? 'rectangle' : 'brush'; setTool(restoredTool); setSelectionTool(restoredTool); }
    setTimeout(() => input.current?.focus(), 150);
    feedback();
  }

  if (!current) return null;
  const currentImage = <FadeImage key={current.url} source={{ uri: current.url }} style={StyleSheet.absoluteFill} resizeMode="contain" accessibilityLabel={`镜头 ${shotNumber} 第 ${current.version} 版`} onLoad={event => {
    const source = event.nativeEvent.source;
    if (source?.width > 0 && source?.height > 0) setImageSize(previous => previous.width === source.width && previous.height === source.height ? previous : { width: source.width, height: source.height });
  }} onError={() => setFailedUrl(current.url)} />;
  const regionText = selectionTool === 'rectangle' ? region && region.w > .002 && region.h > .002 ? `已框选 ${Math.round(region.w * 100)}% × ${Math.round(region.h * 100)}%` : '未框选 · 0 个区域' : `已涂抹 ${strokes.length} 笔`;
  const check = current.edit_check;
  const invalidSelection = localEditing && (selectionTool === 'rectangle' ? !region || region.w < .002 || region.h < .002 : strokes.length === 0);
  return <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={confirmationOverlay ? onDismissConfirmation : onClose}>
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.root} testID="image-viewer" edges={['top', 'bottom']} accessibilityElementsHidden={Boolean(confirmationOverlay)} importantForAccessibility={confirmationOverlay ? 'no-hide-descendants' : 'auto'}>
        <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Animated.View entering={FadeIn.duration(motion.fast).reduceMotion(ReduceMotion.System)} style={styles.header}>
            <Pressable testID="viewer-close" accessibilityRole="button" accessibilityLabel="关闭图片查看器" onPress={() => { feedback(); onClose(); }} style={({ pressed }) => [styles.roundButton, pressed && styles.pressed]}><Ionicons name="close" size={24} color={colors.white} /></Pressable>
            <View style={styles.headerTitle}><Text testID="viewer-current-image" style={styles.title}>镜头 {shotNumber} · v{current.version}</Text><Text style={styles.hint}>{comparing ? '拖动滑块，看修改前后' : localEditing ? tool === 'pan' ? '拖动看细节，再切回涂抹' : '涂抹或框选 · 双指可缩放' : '左右切图 · 双指缩放 · 双击看细节'}</Text>{current.anchor_id ? <Text testID={`viewer-anchor-${current.id}`} style={styles.hint}>以封面为锚点</Text> : null}</View>
            <Pressable testID="viewer-reference" accessibilityRole="button" accessibilityLabel="引用到对话" onPress={() => { feedback(); onReference(current); }} style={({ pressed }) => [styles.roundButton, pressed && styles.pressed]}><Ionicons name="chatbubble-ellipses-outline" size={22} color={colors.white} /></Pressable>
          </Animated.View>

          <GestureDetector gesture={gestures}><View testID="viewer-canvas" style={[styles.canvas, compactKeyboard && { minHeight: 80 }]} onLayout={event => {
            const { width, height } = event.nativeEvent.layout;
            setViewport(previous => previous.width === width && previous.height === height ? previous : { width, height });
          }}>
            {comparing && parent?.url ? <>
              <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, imageStyle]}><FadeImage source={{ uri: parent.url }} style={StyleSheet.absoluteFill} resizeMode="contain" /></Animated.View>
              <View pointerEvents="none" style={[styles.comparisonClip, { width: viewport.width * compare }]}><Animated.View style={[{ width: viewport.width, height: viewport.height }, imageStyle]}>{currentImage}</Animated.View></View>
              <View pointerEvents="none" style={[styles.compareLine, { left: viewport.width * compare }]}><View style={styles.compareHandle}><Ionicons name="code-outline" size={20} color={colors.ink} /></View></View>
              <Text pointerEvents="none" style={[styles.compareLabel, { left: space.md }]}>修改后 v{current.version}</Text><Text pointerEvents="none" style={[styles.compareLabel, { right: space.md }]}>修改前 v{parent.version}</Text>
            </> : <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, imageStyle]}>
              {currentImage}
              {rect && localEditing ? <Svg width={viewport.width} height={viewport.height} style={StyleSheet.absoluteFill}>
                <Defs><ClipPath id="viewer-mask-bounds"><Rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} /></ClipPath></Defs>
                <G clipPath="url(#viewer-mask-bounds)">
                {selectionTool === 'brush' ? strokes.map((stroke, index) => stroke.length === 1 ? <Circle key={index} cx={rect.x + stroke[0].x * rect.width} cy={rect.y + stroke[0].y * rect.height} r={brush * Math.min(rect.width, rect.height) / 2} fill={colors.red} fillOpacity={.46} /> : <Polyline key={index} points={stroke.map(point => `${rect.x + point.x * rect.width},${rect.y + point.y * rect.height}`).join(' ')} fill="none" stroke={colors.red} strokeOpacity={.46} strokeWidth={brush * Math.min(rect.width, rect.height)} strokeLinecap="round" strokeLinejoin="round" />) : null}
                {region && selectionTool === 'rectangle' ? <Rect x={rect.x + region.x * rect.width} y={rect.y + region.y * rect.height} width={region.w * rect.width} height={region.h * rect.height} fill={colors.red} fillOpacity={.25} stroke={colors.red} strokeWidth={2 / transform.scale} /> : null}
                </G>
              </Svg> : null}
            </Animated.View>}
            {!rect && failedUrl !== current.url ? <View style={styles.loadError}><Ionicons name="image-outline" size={36} color={colors.viewerMuted} /><ActivityIndicator color={colors.red} /></View> : null}
            {failedUrl === current.url ? <View style={styles.loadError}><Ionicons name="image-outline" size={36} color={colors.viewerMuted} /><Text style={styles.hint}>图片暂时没加载出来，请关闭后重试</Text><ToolButton title="关闭查看器" testID="viewer-error-close" onPress={onClose} /></View> : null}
            <FidelityBadge image={current} testIDPrefix="viewer-" style={[styles.fidelity, comparing && { top: 48 }]} />
          </View></GestureDetector>

          {comparing ? <View style={styles.compareControl}><Text style={styles.hint}>修改后</Text><TrackSlider value={compare} min={.02} max={.98} label="前后对比位置" testID="viewer-compare-slider" onChange={setCompare} /><Text style={styles.hint}>修改前</Text></View> : null}
          {!compactKeyboard ? <View style={styles.zoomRow}>
            <ToolButton title="上一张" icon="chevron-back" testID="viewer-previous" disabled={currentIndex <= 0} onPress={() => selectAdjacent(-1)} />
            <Pressable testID="viewer-zoom-out" accessibilityRole="button" accessibilityLabel="缩小图片" onPress={() => zoomBy(1 / 1.5)} style={({ pressed }) => [styles.zoomButton, pressed && styles.pressed]}><Ionicons name="remove" color={colors.white} size={20} /></Pressable>
            <Pressable testID="viewer-zoom-reset" accessibilityRole="button" accessibilityLabel="重置缩放" onPress={() => setTransform(IDENTITY_TRANSFORM)} style={({ pressed }) => [styles.zoomButton, pressed && styles.pressed]}><Text testID="viewer-zoom-state" style={styles.zoomText}>{Math.round(transform.scale * 100)}%</Text></Pressable>
            <Pressable testID="viewer-zoom-in" accessibilityRole="button" accessibilityLabel="放大图片" onPress={() => zoomBy(1.5)} style={({ pressed }) => [styles.zoomButton, pressed && styles.pressed]}><Ionicons name="add" color={colors.white} size={20} /></Pressable>
            <ToolButton title="下一张" icon="chevron-forward" testID="viewer-next" disabled={currentIndex < 0 || currentIndex >= available.length - 1} onPress={() => selectAdjacent(1)} />
          </View> : null}

          {!compactKeyboard ? <ScrollView ref={versionsScroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.versionStrip} style={styles.versionScroll} testID="viewer-version-strip">
            {family.map(image => <Pressable key={image.id} testID={`viewer-version-${image.id}`} accessibilityRole="button" accessibilityLabel={`第 ${image.version} 版${image.status === 'succeeded' ? '' : image.status === 'failed' ? '，生成失败' : '，生成中'}`} accessibilityState={{ selected: image.id === current.id, disabled: image.status !== 'succeeded' || !image.url }} disabled={image.status !== 'succeeded' || !image.url} onLayout={event => {
              const { x, width } = event.nativeEvent.layout;
              versionLayouts.current.set(image.id, { x, width });
              if (image.id === current.id) versionsScroll.current?.scrollTo({ x: Math.max(0, x + width / 2 - viewport.width / 2), animated: true });
            }} onPress={() => selectImage(image.id)} style={({ pressed }) => [styles.version, image.id === current.id && styles.versionSelected, pressed && styles.pressed]}>
              {image.url ? <FadeImage source={{ uri: image.url }} style={styles.versionImage} /> : <View style={styles.versionPlaceholder}>{image.status === 'failed' ? <Ionicons name="alert-circle-outline" color={colors.red} size={20} /> : <ActivityIndicator size="small" color={colors.red} />}</View>}
              <Badge tone={image.id === current.id ? 'brand' : 'inverse'} label={`v${image.version}${image.status === 'succeeded' ? '' : image.status === 'failed' ? ' · 失败' : ' · 生成中'}`} />
              {image.edit_check?.passed === false ? <Badge tone="danger" label="未改到位" /> : null}
            </Pressable>)}
            {pending && !pendingImage ? <View testID="viewer-pending-version" style={styles.version}><View style={styles.versionPlaceholder}><ActivityIndicator size="small" color={colors.red} /></View><Badge tone="inverse" label="新版本 · 排队中" /></View> : null}
          </ScrollView> : null}

          {!compactKeyboard ? (check ? <View testID={`viewer-edit-check-${current.id}`} style={[styles.check, !check.passed && styles.checkFailed]}><Text style={[styles.checkText, !check.passed && styles.checkFailedText]}>{check.passed ? '✓ 已按要求改好' : '可能没改到位'}：{check.reason}</Text>{!check.passed ? <View style={styles.checkActions}><Pressable accessibilityRole="button" testID="viewer-retry-edit" accessibilityLabel="再试一次" disabled={generationBusy || !canEdit || !current.parent_id || !current.instruction} onPress={() => { void sendEdit(retryAction()); }} style={({ pressed }) => [styles.retryButton, (generationBusy || !canEdit) && styles.disabled, pressed && styles.pressed]}><Text style={styles.retryText}>再试一次</Text></Pressable><Pressable accessibilityRole="button" testID="viewer-rephrase-edit" accessibilityLabel="换个说法" disabled={generationBusy || !canEdit} onPress={rephrase} style={({ pressed }) => [styles.retryButton, (generationBusy || !canEdit) && styles.disabled, pressed && styles.pressed]}><Text style={styles.retryText}>换个说法</Text></Pressable></View> : null}</View> : current.instruction ? <Text numberOfLines={2} style={styles.instructionCaption}>{current.instruction}</Text> : null) : null}
          {error ? <Text testID="viewer-error" accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {reusedNotice ? <Text testID="viewer-reused" accessibilityRole="status" style={styles.instructionCaption}>{reusedNotice}</Text> : null}
          {!editing && onAdopt ? <View style={styles.adoptionRow}><ToolButton title={adoptedImageIds.includes(current.id) ? stage === 'note' ? '笔记正在用这版' : '已选这版' : stage === 'note' ? '采用此版本到笔记' : check?.passed === false ? '仍然采用' : '选用此版本'} testID="viewer-adopt-version" disabled={generationBusy || adopting || adoptedImageIds.includes(current.id)} onPress={() => {
            setAdopting(true);
            void onAdopt(current).catch(failure => setError(failure instanceof Error ? failure.message : '采用失败，请重试。')).finally(() => setAdopting(false));
          }} /></View> : null}

          <Animated.View key={editing ? 'editing' : 'viewing'} entering={FadeInDown.duration(motion.fast).reduceMotion(ReduceMotion.System)} style={styles.bottom}>
            {editing ? <>
              <View style={styles.editHeading}><Text style={styles.title}>{localEditing ? '圈出想改的地方' : '整张图片怎么改'}</Text><ToolButton title="取消" testID="viewer-cancel-edit" onPress={() => changeMode('view')} /></View>
              {localEditing ? <>
                <View style={styles.drawingTools}><ToolButton title="涂抹" icon="brush-outline" testID="viewer-mode-brush" selected={tool === 'brush'} onPress={() => { setTool('brush'); setSelectionTool('brush'); feedback(); }} /><ToolButton title="框选" icon="scan-outline" testID="viewer-mode-rectangle" selected={tool === 'rectangle'} onPress={() => { setTool('rectangle'); setSelectionTool('rectangle'); feedback(); }} /><ToolButton title="移动" icon="hand-left-outline" testID="viewer-mode-pan" selected={tool === 'pan'} onPress={() => { setTool('pan'); feedback(); }} /><ToolButton title="撤销" testID="viewer-undo" disabled={selectionTool === 'rectangle' ? !region : !strokes.length} onPress={() => { if (selectionTool === 'rectangle') setRegion(null); else { strokeRef.current = strokeRef.current.slice(0, -1); setStrokes(strokeRef.current); } feedback(); }} /><ToolButton title="清空" testID="viewer-clear" disabled={!region && !strokes.length} onPress={() => { clearSelection(); feedback(); }} /></View>
                {selectionTool !== 'rectangle' ? <View style={styles.brushRow}><Text style={styles.hint}>笔刷 {Math.round(brush * 100)}%</Text><TrackSlider value={brush} min={.015} max={.22} label="笔刷粗细" testID="viewer-brush-size" onChange={setBrush} /></View> : null}
                <Text testID="viewer-region-status" style={styles.selectionStatus}>{regionText}</Text>
              </> : null}
              <Text style={styles.suggestionContext}>{suggestionContext}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.suggestions} style={styles.suggestionsScroll}>
                {QUICK_EDITS.map((text, index) => ({ text, index })).sort((a, b) => Number(recommendedEdits.includes(b.index)) - Number(recommendedEdits.includes(a.index)) || a.index - b.index).map(({ text, index }) => <Pressable key={text} testID={`edit-suggestion-${index}`} accessibilityRole="button" accessibilityLabel={text} onPress={() => { if (index < QUICK_EDITS.length - 1) setInstruction(text); input.current?.focus(); feedback(); }} style={({ pressed }) => [styles.suggestion, recommendedEdits.includes(index) && styles.suggestionRecommended, pressed && styles.pressed]}><Text style={styles.suggestionText}>{text}</Text></Pressable>)}
              </ScrollView>
              <View style={styles.inputRow}><TextInput ref={input} testID="edit-instruction" accessibilityLabel="改图要求" placeholder="说说这里想怎么改…" placeholderTextColor={colors.viewerMuted} value={instruction} onChangeText={setInstruction} style={styles.input} multiline maxLength={2000} editable={!generationBusy} /><Pressable testID="submit-edit" accessibilityRole="button" accessibilityLabel="提交改图" accessibilityState={{ disabled: generationBusy || !instruction.trim() || invalidSelection }} disabled={generationBusy || !instruction.trim() || invalidSelection} onPress={() => { void sendEdit(); }} style={({ pressed }) => [styles.submit, (generationBusy || !instruction.trim() || invalidSelection) && styles.disabled, pressed && styles.pressed]}>{generationBusy ? <ActivityIndicator color={colors.white} /> : <Ionicons name="arrow-up" size={23} color={colors.white} />}</Pressable></View>
            </> : <View style={styles.mainActions}><ToolButton title="局部改" icon="brush-outline" testID="viewer-mode-local" disabled={!canEdit || generationBusy || !rect || failedUrl === current.url} onPress={() => changeMode('local')} /><ToolButton title="整张改" icon="color-wand-outline" testID="viewer-mode-whole" disabled={!canEdit || generationBusy || !current.url} onPress={() => changeMode('whole')} /><ToolButton title={comparing ? '结束对比' : '对比版本'} icon="git-compare-outline" testID="viewer-compare-toggle" disabled={!parent?.url} selected={comparing} onPress={() => changeMode(comparing ? 'view' : 'compare')} /></View>}
            {!canEdit && !comparing && !localEditing ? <Text testID="viewer-locked-hint" style={[styles.hint, styles.lockedHint]}>视频已生成，这组图片已定稿；想继续改图，可以拍一组新片。</Text> : null}
            {pending && !editing ? <View testID="viewer-generation-status" style={styles.generationStatus}><ProgressStrip title="新版本生成中，完成后自动对比" /></View> : null}
          </Animated.View>
        </KeyboardAvoidingView>
      </SafeAreaView>
      {confirmationOverlay}
    </GestureHandlerRootView>
  </Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.viewerBg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.sm },
  roundButton: { width: layout.touch, height: layout.touch, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, backgroundColor: colors.viewerSurface },
  headerTitle: { flex: 1, gap: space.xs },
  title: { ...typography.body, color: colors.white, fontWeight: '700' },
  hint: { ...typography.caption, color: colors.viewerMuted },
  adoptionRow: { alignItems: 'center', paddingHorizontal: space.lg },
  lockedHint: { textAlign: 'center', paddingHorizontal: space.inset20, paddingBottom: space.sm },
  canvas: { flex: 1, minHeight: 140, overflow: 'hidden', backgroundColor: colors.viewerCanvas },
  loadError: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.lg },
  fidelity: { position: 'absolute', left: space.md, top: space.md },
  comparisonClip: { position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden' },
  compareLine: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  compareHandle: { width: 36, height: 36, borderRadius: radius.lg, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  compareLabel: { ...typography.caption, position: 'absolute', top: space.md, color: colors.white, backgroundColor: colors.viewerSurface, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm },
  compareControl: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg },
  zoomRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: space.xs, paddingHorizontal: space.sm, minHeight: 52 },
  zoomButton: { minWidth: layout.touch, minHeight: layout.touch, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  zoomText: { ...typography.caption, color: colors.viewerMuted, textAlign: 'center' },
  toolButton: { minHeight: layout.touch, minWidth: layout.touch, paddingHorizontal: space.sm, paddingVertical: space.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, borderRadius: radius.sm },
  toolText: { ...typography.caption, fontWeight: '600', color: colors.white },
  toolSelected: { backgroundColor: colors.viewerSelected },
  selectedText: { color: colors.white },
  disabled: { opacity: .35 },
  pressed: { opacity: .75, transform: [{ scale: .97 }] },
  versionScroll: { flexGrow: 0, maxHeight: 112, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.viewerLine },
  versionStrip: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm },
  version: { padding: space.xs, borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent', minWidth: 64, minHeight: 88, alignItems: 'center', gap: space.xs },
  versionSelected: { borderColor: colors.red, backgroundColor: colors.viewerSelected },
  versionImage: { width: 36, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm, backgroundColor: colors.viewerSurface },
  versionPlaceholder: { width: 36, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm, backgroundColor: colors.viewerSurface, alignItems: 'center', justifyContent: 'center' },
  check: { marginHorizontal: space.lg, marginVertical: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.sm, backgroundColor: colors.successSoft },
  checkFailed: { backgroundColor: colors.blush },
  checkText: { ...typography.caption, color: colors.green },
  checkFailedText: { color: colors.danger },
  checkActions: { flexDirection: 'row', gap: space.lg, marginTop: space.xs },
  retryButton: { minHeight: layout.touch, justifyContent: 'center', paddingHorizontal: space.sm, borderRadius: radius.sm },
  retryText: { ...typography.label, color: colors.redText },
  instructionCaption: { ...typography.caption, color: colors.viewerMuted, marginHorizontal: space.lg, marginVertical: space.sm },
  error: { ...typography.caption, color: colors.white, backgroundColor: colors.viewerSelected, borderRadius: radius.sm, marginHorizontal: space.lg, marginVertical: space.sm, padding: space.md },
  bottom: { paddingHorizontal: space.lg, paddingBottom: space.md, paddingTop: space.sm, borderTopColor: colors.viewerLine, borderTopWidth: StyleSheet.hairlineWidth },
  mainActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  generationStatus: { paddingTop: space.sm },
  editHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  drawingTools: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.none },
  brushRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingHorizontal: space.xs },
  slider: { flex: 1, height: layout.touch, justifyContent: 'center', minWidth: 60 },
  sliderTrack: { height: space.xs, borderRadius: radius.sm, backgroundColor: colors.viewerLine },
  sliderFill: { height: space.xs, borderRadius: radius.sm, backgroundColor: colors.red },
  sliderKnob: { position: 'absolute', width: 20, height: 20, marginLeft: -space.offset10, borderRadius: radius.sm, backgroundColor: colors.white, borderWidth: 2, borderColor: colors.red },
  selectionStatus: { ...typography.caption, color: colors.viewerMuted, marginLeft: space.xs },
  suggestionsScroll: { flexGrow: 0, marginTop: space.sm, marginBottom: space.sm },
  suggestionContext: { ...typography.caption, color: colors.viewerMuted, marginLeft: space.xs, marginTop: space.sm },
  suggestions: { gap: space.sm, paddingVertical: space.xs },
  suggestion: { minHeight: layout.touch, justifyContent: 'center', paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md, backgroundColor: colors.viewerSurface, borderWidth: 1, borderColor: colors.viewerLine },
  suggestionRecommended: { borderColor: colors.red, backgroundColor: colors.viewerSelected },
  suggestionText: { ...typography.caption, color: colors.white },
  inputRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  input: { ...typography.body, flex: 1, minHeight: 48, maxHeight: 88, paddingHorizontal: space.md, paddingVertical: space.md, borderRadius: radius.sm, backgroundColor: colors.viewerSurface, color: colors.white },
  submit: { width: 48, height: 48, borderRadius: radius.md, backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center' },
});
