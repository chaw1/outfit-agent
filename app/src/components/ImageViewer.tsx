import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, ClipPath, Defs, G, Polyline, Rect } from 'react-native-svg';
import type { Action, ImageRegion, OutfitImage } from '../api/types';
import { feedback } from '../lib/haptics';
import { clamp, constrainTransform, containRect, editActionForResult, IDENTITY_TRANSFORM, imageVersionFamily, regionFromPoints, screenToImage, zoomAtPoint, type ImageTransform, type Point, type Size } from '../lib/imageGeometry';

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
  onClose: () => void;
  onAction: (action: Action) => Promise<unknown> | void;
  onReference: (image: OutfitImage) => void;
}

const QUICK_EDITS = ['袖口放下来', '衬衫塞进裤腰', '去掉吊牌', '换个颜色', '背景亮一点', '自己输入'];
const EMPTY_SIZE = { width: 0, height: 0 };

function ToolButton({ title, icon, testID, onPress, selected, disabled }: { title: string; icon?: React.ComponentProps<typeof Ionicons>['name']; testID: string; onPress: () => void; selected?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ selected, disabled: Boolean(disabled) }} testID={testID} onPress={onPress} disabled={disabled} style={({ pressed }) => [styles.toolButton, selected && styles.toolSelected, disabled && styles.disabled, pressed && styles.pressed]}>
    {icon ? <Ionicons name={icon} size={18} color={selected ? '#FF7086' : '#F8F5F1'} /> : null}<Text style={[styles.toolText, selected && styles.selectedText]}>{title}</Text>
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

export function ImageViewer({ images, editActions = [], initialImageId, initialMode = 'view', busy = false, canEdit = true, onClose, onAction, onReference }: ImageViewerProps) {
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
  const [keyboardVisible, setKeyboardVisible] = useState(() => Platform.OS !== 'web' && Keyboard.isVisible());
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const [pending, setPending] = useState<{ parentId: string; knownIds: Set<string>; action: EditAction } | null>(null);
  const resultActions = useRef(new Map<string, EditAction>());
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
  }, [images, pending, resetForImage]);
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
    setSubmitting(true);
    setError(undefined);
    const previousMode = mode;
    setMode('view');
    setPending({ parentId: payload.image_id, knownIds: new Set(images.map(image => image.id)), action: payload });
    feedback();
    try {
      const accepted = await onAction(payload);
      if (accepted === false) throw new Error('还没确认服务是否收到，请先刷新项目后再重试。');
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
  const currentImage = <Image source={{ uri: current.url }} style={StyleSheet.absoluteFill} resizeMode="contain" accessibilityLabel={`镜头 ${shotNumber} 第 ${current.version} 版`} onLoad={event => {
    const source = event.nativeEvent.source;
    if (source?.width > 0 && source?.height > 0) setImageSize(previous => previous.width === source.width && previous.height === source.height ? previous : { width: source.width, height: source.height });
  }} onError={() => setFailedUrl(current.url)} />;
  const regionText = selectionTool === 'rectangle' ? region && region.w > .002 && region.h > .002 ? `已框选 ${Math.round(region.w * 100)}% × ${Math.round(region.h * 100)}%` : '未框选 · 0 个区域' : `已涂抹 ${strokes.length} 笔`;
  const check = current.edit_check;
  const invalidSelection = localEditing && (selectionTool === 'rectangle' ? !region || region.w < .002 || region.h < .002 : strokes.length === 0);
  return <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.root} testID="image-viewer" edges={['top', 'bottom']}>
        <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <Pressable testID="viewer-close" accessibilityRole="button" accessibilityLabel="关闭图片查看器" onPress={() => { feedback(); onClose(); }} style={styles.roundButton}><Ionicons name="close" size={25} color="white" /></Pressable>
            <View style={styles.headerTitle}><Text testID="viewer-current-image" style={styles.title}>镜头 {shotNumber} · v{current.version}</Text><Text style={styles.hint}>{comparing ? '拖动滑块，看修改前后' : localEditing ? tool === 'pan' ? '拖动看细节，再切回涂抹' : '涂抹或框选 · 双指可缩放' : '左右切图 · 双指缩放 · 双击看细节'}</Text></View>
            <Pressable testID="viewer-reference" accessibilityRole="button" accessibilityLabel="引用到对话" onPress={() => { feedback(); onReference(current); }} style={styles.roundButton}><Ionicons name="chatbubble-ellipses-outline" size={23} color="white" /></Pressable>
          </View>

          <GestureDetector gesture={gestures}><View testID="viewer-canvas" style={[styles.canvas, compactKeyboard && { minHeight: 80 }]} onLayout={event => {
            const { width, height } = event.nativeEvent.layout;
            setViewport(previous => previous.width === width && previous.height === height ? previous : { width, height });
          }}>
            {comparing && parent?.url ? <>
              <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, imageStyle]}><Image source={{ uri: parent.url }} style={StyleSheet.absoluteFill} resizeMode="contain" /></Animated.View>
              <View pointerEvents="none" style={[styles.comparisonClip, { width: viewport.width * compare }]}><Animated.View style={[{ width: viewport.width, height: viewport.height }, imageStyle]}>{currentImage}</Animated.View></View>
              <View pointerEvents="none" style={[styles.compareLine, { left: viewport.width * compare }]}><View style={styles.compareHandle}><Ionicons name="code-outline" size={20} color="#191A1D" /></View></View>
              <Text pointerEvents="none" style={[styles.compareLabel, { left: 12 }]}>修改后 v{current.version}</Text><Text pointerEvents="none" style={[styles.compareLabel, { right: 12 }]}>修改前 v{parent.version}</Text>
            </> : <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, imageStyle]}>
              {currentImage}
              {rect && localEditing ? <Svg width={viewport.width} height={viewport.height} style={StyleSheet.absoluteFill}>
                <Defs><ClipPath id="viewer-mask-bounds"><Rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} /></ClipPath></Defs>
                <G clipPath="url(#viewer-mask-bounds)">
                {selectionTool === 'brush' ? strokes.map((stroke, index) => stroke.length === 1 ? <Circle key={index} cx={rect.x + stroke[0].x * rect.width} cy={rect.y + stroke[0].y * rect.height} r={brush * Math.min(rect.width, rect.height) / 2} fill="#FF567E" fillOpacity={.46} /> : <Polyline key={index} points={stroke.map(point => `${rect.x + point.x * rect.width},${rect.y + point.y * rect.height}`).join(' ')} fill="none" stroke="#FF567E" strokeOpacity={.46} strokeWidth={brush * Math.min(rect.width, rect.height)} strokeLinecap="round" strokeLinejoin="round" />) : null}
                {region && selectionTool === 'rectangle' ? <Rect x={rect.x + region.x * rect.width} y={rect.y + region.y * rect.height} width={region.w * rect.width} height={region.h * rect.height} fill="#FF567E" fillOpacity={.25} stroke="#FF86A0" strokeWidth={2 / transform.scale} /> : null}
                </G>
              </Svg> : null}
            </Animated.View>}
            {!rect && failedUrl !== current.url ? <ActivityIndicator style={StyleSheet.absoluteFill} color="#FF7086" /> : null}
            {failedUrl === current.url ? <View style={styles.loadError}><Ionicons name="image-outline" size={35} color="#A3A0A5" /><Text style={styles.hint}>图片暂时没加载出来，请关闭后重试</Text></View> : null}
            {typeof current.fidelity?.score === 'number' && Number.isFinite(current.fidelity.score) ? <View pointerEvents="none" style={[styles.fidelity, comparing && { top: 43 }]}><Text style={styles.fidelityText}>还原 {Math.round(current.fidelity.score)}</Text></View> : null}
          </View></GestureDetector>

          {comparing ? <View style={styles.compareControl}><Text style={styles.hint}>修改后</Text><TrackSlider value={compare} min={.02} max={.98} label="前后对比位置" testID="viewer-compare-slider" onChange={setCompare} /><Text style={styles.hint}>修改前</Text></View> : null}
          {!compactKeyboard ? <View style={styles.zoomRow}>
            <ToolButton title="上一张" icon="chevron-back" testID="viewer-previous" disabled={currentIndex <= 0} onPress={() => selectAdjacent(-1)} />
            <Pressable testID="viewer-zoom-out" accessibilityRole="button" accessibilityLabel="缩小图片" onPress={() => zoomBy(1 / 1.5)} style={styles.zoomButton}><Ionicons name="remove" color="white" size={19} /></Pressable>
            <Pressable testID="viewer-zoom-reset" accessibilityRole="button" accessibilityLabel="重置缩放" onPress={() => setTransform(IDENTITY_TRANSFORM)}><Text testID="viewer-zoom-state" style={styles.zoomText}>{Math.round(transform.scale * 100)}%</Text></Pressable>
            <Pressable testID="viewer-zoom-in" accessibilityRole="button" accessibilityLabel="放大图片" onPress={() => zoomBy(1.5)} style={styles.zoomButton}><Ionicons name="add" color="white" size={19} /></Pressable>
            <ToolButton title="下一张" icon="chevron-forward" testID="viewer-next" disabled={currentIndex < 0 || currentIndex >= available.length - 1} onPress={() => selectAdjacent(1)} />
          </View> : null}

          {!compactKeyboard ? <ScrollView ref={versionsScroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.versionStrip} style={styles.versionScroll} testID="viewer-version-strip">
            {family.map(image => <Pressable key={image.id} testID={`viewer-version-${image.id}`} accessibilityRole="button" accessibilityLabel={`第 ${image.version} 版${image.status === 'succeeded' ? '' : image.status === 'failed' ? '，生成失败' : '，生成中'}`} accessibilityState={{ selected: image.id === current.id, disabled: image.status !== 'succeeded' || !image.url }} disabled={image.status !== 'succeeded' || !image.url} onLayout={event => {
              const { x, width } = event.nativeEvent.layout;
              versionLayouts.current.set(image.id, { x, width });
              if (image.id === current.id) versionsScroll.current?.scrollTo({ x: Math.max(0, x + width / 2 - viewport.width / 2), animated: true });
            }} onPress={() => selectImage(image.id)} style={[styles.version, image.id === current.id && styles.versionSelected]}>
              {image.url ? <Image source={{ uri: image.url }} style={styles.versionImage} /> : <View style={styles.versionPlaceholder}>{image.status === 'failed' ? <Ionicons name="alert-circle-outline" color="#FF7086" size={20} /> : <ActivityIndicator size="small" color="#FF7086" />}</View>}
              <Text style={[styles.versionText, image.id === current.id && styles.selectedText]}>v{image.version}{image.status === 'succeeded' ? '' : image.status === 'failed' ? ' · 失败' : ' · 生成中'}</Text>
            </Pressable>)}
            {pending && !pendingImage ? <View testID="viewer-pending-version" style={styles.version}><View style={styles.versionPlaceholder}><ActivityIndicator size="small" color="#FF7086" /></View><Text style={styles.versionText}>新版本 · 排队中</Text></View> : null}
          </ScrollView> : null}

          {!compactKeyboard ? (check ? <View testID={`viewer-edit-check-${current.id}`} style={[styles.check, !check.passed && styles.checkFailed]}><Text style={[styles.checkText, !check.passed && styles.checkFailedText]}>{check.passed ? '✓ 已按要求改好' : '可能没改到位'}：{check.reason}</Text>{!check.passed ? <View style={styles.checkActions}><Pressable accessibilityRole="button" testID="viewer-retry-edit" accessibilityLabel="再试一次" disabled={generationBusy || !canEdit || !current.parent_id || !current.instruction} onPress={() => { void sendEdit(retryAction()); }} style={generationBusy || !canEdit ? styles.disabled : undefined}><Text style={styles.retryText}>再试一次</Text></Pressable><Pressable accessibilityRole="button" testID="viewer-rephrase-edit" accessibilityLabel="换个说法" disabled={generationBusy || !canEdit} onPress={rephrase} style={generationBusy || !canEdit ? styles.disabled : undefined}><Text style={styles.retryText}>换个说法</Text></Pressable></View> : null}</View> : current.instruction ? <Text numberOfLines={2} style={styles.instructionCaption}>{current.instruction}</Text> : null) : null}
          {error ? <Text testID="viewer-error" accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

          <View style={styles.bottom}>
            {editing ? <>
              <View style={styles.editHeading}><Text style={styles.title}>{localEditing ? '圈出想改的地方' : '整张图片怎么改'}</Text><ToolButton title="取消" testID="viewer-cancel-edit" onPress={() => changeMode('view')} /></View>
              {localEditing ? <>
                <View style={styles.drawingTools}><ToolButton title="涂抹" icon="brush-outline" testID="viewer-mode-brush" selected={tool === 'brush'} onPress={() => { setTool('brush'); setSelectionTool('brush'); feedback(); }} /><ToolButton title="框选" icon="scan-outline" testID="viewer-mode-rectangle" selected={tool === 'rectangle'} onPress={() => { setTool('rectangle'); setSelectionTool('rectangle'); feedback(); }} /><ToolButton title="移动" icon="hand-left-outline" testID="viewer-mode-pan" selected={tool === 'pan'} onPress={() => { setTool('pan'); feedback(); }} /><ToolButton title="撤销" testID="viewer-undo" disabled={selectionTool === 'rectangle' ? !region : !strokes.length} onPress={() => { if (selectionTool === 'rectangle') setRegion(null); else { strokeRef.current = strokeRef.current.slice(0, -1); setStrokes(strokeRef.current); } feedback(); }} /><ToolButton title="清空" testID="viewer-clear" disabled={!region && !strokes.length} onPress={() => { clearSelection(); feedback(); }} /></View>
                {selectionTool !== 'rectangle' ? <View style={styles.brushRow}><Text style={styles.hint}>笔刷 {Math.round(brush * 100)}%</Text><TrackSlider value={brush} min={.015} max={.22} label="笔刷粗细" testID="viewer-brush-size" onChange={setBrush} /></View> : null}
                <Text testID="viewer-region-status" style={styles.selectionStatus}>{regionText}</Text>
              </> : null}
              <Text style={styles.suggestionContext}>{suggestionContext}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.suggestions} style={styles.suggestionsScroll}>
                {QUICK_EDITS.map((text, index) => ({ text, index })).sort((a, b) => Number(recommendedEdits.includes(b.index)) - Number(recommendedEdits.includes(a.index)) || a.index - b.index).map(({ text, index }) => <Pressable key={text} testID={`edit-suggestion-${index}`} accessibilityRole="button" accessibilityLabel={text} onPress={() => { if (index < QUICK_EDITS.length - 1) setInstruction(text); input.current?.focus(); feedback(); }} style={[styles.suggestion, recommendedEdits.includes(index) && styles.suggestionRecommended]}><Text style={styles.suggestionText}>{text}</Text></Pressable>)}
              </ScrollView>
              <View style={styles.inputRow}><TextInput ref={input} testID="edit-instruction" accessibilityLabel="改图要求" placeholder="说说这里想怎么改…" placeholderTextColor="#98939A" value={instruction} onChangeText={setInstruction} style={styles.input} multiline maxLength={2000} editable={!generationBusy} /><Pressable testID="submit-edit" accessibilityRole="button" accessibilityLabel="提交改图" accessibilityState={{ disabled: generationBusy || !instruction.trim() || invalidSelection }} disabled={generationBusy || !instruction.trim() || invalidSelection} onPress={() => { void sendEdit(); }} style={[styles.submit, (generationBusy || !instruction.trim() || invalidSelection) && styles.disabled]}>{generationBusy ? <ActivityIndicator color="white" /> : <Ionicons name="arrow-up" size={23} color="white" />}</Pressable></View>
            </> : <View style={styles.mainActions}><ToolButton title="局部改" icon="brush-outline" testID="viewer-mode-local" disabled={!canEdit || generationBusy || !rect || failedUrl === current.url} onPress={() => changeMode('local')} /><ToolButton title="整张改" icon="color-wand-outline" testID="viewer-mode-whole" disabled={!canEdit || generationBusy || !current.url} onPress={() => changeMode('whole')} /><ToolButton title={comparing ? '结束对比' : '对比版本'} icon="git-compare-outline" testID="viewer-compare-toggle" disabled={!parent?.url} selected={comparing} onPress={() => changeMode(comparing ? 'view' : 'compare')} /></View>}
            {pending && !editing ? <Text testID="viewer-generation-status" style={styles.generationStatus}>新版本生成中，完成后自动对比</Text> : null}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </GestureHandlerRootView>
  </Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#171719' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  roundButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 24 },
  headerTitle: { flex: 1, gap: 5 },
  title: { color: '#F8F5F1', fontWeight: '700', fontSize: 14 },
  hint: { color: '#B4ADB3', fontSize: 10, lineHeight: 16 },
  canvas: { flex: 1, minHeight: 140, overflow: 'hidden', backgroundColor: '#0E0E10' },
  loadError: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 12 },
  fidelity: { position: 'absolute', left: 12, top: 12, borderRadius: 5, backgroundColor: '#F8F5F1ED', paddingHorizontal: 8, paddingVertical: 5 },
  fidelityText: { fontSize: 11, fontWeight: '600', color: '#34735A' },
  comparisonClip: { position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden' },
  compareLine: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  compareHandle: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'white', alignItems: 'center', justifyContent: 'center' },
  compareLabel: { position: 'absolute', top: 12, color: 'white', backgroundColor: '#171719B8', fontSize: 10, paddingHorizontal: 7, paddingVertical: 5, borderRadius: 4 },
  compareControl: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20 },
  zoomRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10, paddingHorizontal: 10, minHeight: 46 },
  zoomButton: { width: 38, height: 40, alignItems: 'center', justifyContent: 'center' },
  zoomText: { color: '#D7D1D5', fontSize: 11, minWidth: 40, textAlign: 'center', paddingVertical: 10 },
  toolButton: { minHeight: 40, paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 9 },
  toolText: { fontSize: 11, fontWeight: '500', color: '#E7E0E5' },
  toolSelected: { backgroundColor: '#FF244221' },
  selectedText: { color: '#FF8AA0' },
  disabled: { opacity: .35 },
  pressed: { opacity: .7 },
  versionScroll: { flexGrow: 0, maxHeight: 86, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#FFFFFF1A' },
  versionStrip: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, gap: 10 },
  version: { padding: 3, borderRadius: 7, borderWidth: 1.5, borderColor: '#FFFFFF00', minWidth: 52, alignItems: 'center', gap: 5 },
  versionSelected: { borderColor: '#FF617F', backgroundColor: '#FF244218' },
  versionImage: { width: 41, height: 42, borderRadius: 3, backgroundColor: '#343239' },
  versionPlaceholder: { width: 41, height: 42, borderRadius: 3, backgroundColor: '#343239', alignItems: 'center', justifyContent: 'center' },
  versionText: { color: '#B9AFB6', fontSize: 9 },
  check: { marginHorizontal: 16, marginTop: 6, marginBottom: 5, paddingHorizontal: 11, paddingVertical: 9, borderRadius: 8, backgroundColor: '#2A3D32' },
  checkFailed: { backgroundColor: '#493331' },
  checkText: { color: '#B6E4C7', fontSize: 11, lineHeight: 17 },
  checkFailedText: { color: '#FFD1B7' },
  checkActions: { flexDirection: 'row', gap: 24, marginTop: 5 },
  retryText: { color: '#FFBBC5', fontSize: 12, fontWeight: '600', paddingVertical: 5 },
  instructionCaption: { color: '#B4ADB3', fontSize: 10, lineHeight: 15, marginHorizontal: 18, marginVertical: 6 },
  error: { color: '#FFAEBA', fontSize: 11, lineHeight: 17, marginHorizontal: 18, marginVertical: 5 },
  bottom: { paddingHorizontal: 14, paddingBottom: 12, paddingTop: 5, borderTopColor: '#FFFFFF14', borderTopWidth: StyleSheet.hairlineWidth },
  mainActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  generationStatus: { fontSize: 11, color: '#FFB4C2', textAlign: 'center', paddingTop: 7 },
  editHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  drawingTools: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 0 },
  brushRow: { flexDirection: 'row', alignItems: 'center', gap: 20, paddingHorizontal: 7 },
  slider: { flex: 1, height: 32, justifyContent: 'center', minWidth: 60 },
  sliderTrack: { height: 3, borderRadius: 3, backgroundColor: '#555059' },
  sliderFill: { height: 3, borderRadius: 3, backgroundColor: '#FF7086' },
  sliderKnob: { position: 'absolute', width: 18, height: 18, marginLeft: -9, borderRadius: 10, backgroundColor: '#F8F5F1', borderWidth: 2, borderColor: '#FF7086' },
  selectionStatus: { fontSize: 10, color: '#C7B5BF', marginLeft: 7, marginTop: 1 },
  suggestionsScroll: { flexGrow: 0, marginTop: 6, marginBottom: 8 },
  suggestionContext: { fontSize: 10, color: '#B4ADB3', marginLeft: 7, marginTop: 5 },
  suggestions: { gap: 7, paddingVertical: 3 },
  suggestion: { paddingHorizontal: 11, paddingVertical: 9, borderRadius: 15, backgroundColor: '#2D292E', borderWidth: 1, borderColor: '#51414A' },
  suggestionRecommended: { borderColor: '#835060', backgroundColor: '#3F2D35' },
  suggestionText: { color: '#E8C2CD', fontSize: 11 },
  inputRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  input: { flex: 1, minHeight: 47, maxHeight: 83, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 12, backgroundColor: '#2B282D', color: '#F8F5F1', fontSize: 13, lineHeight: 20 },
  submit: { width: 45, height: 45, borderRadius: 23, backgroundColor: '#FF2442', alignItems: 'center', justifyContent: 'center' },
});
