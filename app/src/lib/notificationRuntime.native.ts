import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, IosAuthorizationStatus } from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { AppState, Platform } from 'react-native';
import { ApiClient } from '../api/client';
import type { ProjectState } from '../api/types';
import { appendRecentCompletions, checkGeneration, createGenerationRuntime, deliverCompletion, needsGenerationCheck, notificationOwner, notificationProject, parseSavedGenerations, type Completion, type CompletionListener, type NotificationSession } from './completionTracker';
import { setRecentCompletions } from './completionFeed';
export type { NotificationSession, CompletionListener } from './completionTracker';

const TASK = 'outfit-generation-results';
const STORAGE = 'outfit.generation-watch.v1';
const CHANNEL = 'generation-results';
let permissionOwner: string | undefined;
let permissionAsked = false;
let configured = false;
const isForeground = () => AppState.currentState === 'active' || !AppState.currentState;
const hasPermission = async () => {
  const permission = await Notifications.getPermissionsAsync();
  return permission.granted || permission.ios?.status === IosAuthorizationStatus.PROVISIONAL;
};
Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: !isForeground(), shouldShowList: !isForeground(), shouldPlaySound: false, shouldSetBadge: false }) });

async function deliver(completion: Completion, owner: string, isCurrent: () => boolean, listener?: CompletionListener, revalidate?: () => Promise<boolean>) {
  await deliverCompletion(completion, owner, {
    isForeground, isCurrent, permissionGranted: async () => await hasPermission() && (!revalidate || await revalidate()),
    foreground: value => listener?.(value),
    schedule: async (value, expectedOwner) => {
      if (!isCurrent()) return;
      await Notifications.scheduleNotificationAsync({
        identifier: `outfit-${encodeURIComponent(expectedOwner)}-${value.projectId}-${value.jobIds.join('-')}`,
        content: { title: value.title, body: value.body, sound: false, data: { projectId: value.projectId, owner: expectedOwner } },
        trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
      });
    },
  });
}
const runtime = createGenerationRuntime({
  load: () => AsyncStorage.getItem(STORAGE),
  save: value => value === null ? AsyncStorage.removeItem(STORAGE) : AsyncStorage.setItem(STORAGE, value),
  onCompletions: setRecentCompletions,
  deliver,
});

// This definition is evaluated when the OS starts the JS bundle without a mounted UI.
TaskManager.defineTask(TASK, async () => {
  try {
    if (isForeground()) return BackgroundTask.BackgroundTaskResult.Success;
    let expectedRaw = await AsyncStorage.getItem(STORAGE);
    const saved = parseSavedGenerations(expectedRaw);
    const token = await SecureStore.getItemAsync('outfit.session');
    if (!saved || !token) return BackgroundTask.BackgroundTaskResult.Success;
    const configuredBase = await SecureStore.getItemAsync('outfit.server');
    if (configuredBase && configuredBase !== saved.baseUrl) return BackgroundTask.BackgroundTaskResult.Success;
    const api = new ApiClient({ baseUrl: saved.baseUrl, token });
    const user = await api.me();
    if (notificationOwner({ baseUrl: saved.baseUrl, userId: user.id }) !== saved.owner) return BackgroundTask.BackgroundTaskResult.Success;
    let current = true;
    const stillCurrent = async () => {
      const [currentToken, currentBase, raw] = await Promise.all([SecureStore.getItemAsync('outfit.session'), SecureStore.getItemAsync('outfit.server'), AsyncStorage.getItem(STORAGE)]);
      current = !isForeground() && (!configured || runtime.currentOwner() === saved.owner) && currentToken === token && (!currentBase || currentBase === saved.baseUrl) && raw === expectedRaw;
      return current;
    };
    const save = async () => {
      expectedRaw = JSON.stringify(saved);
      await AsyncStorage.setItem(STORAGE, expectedRaw);
    };
    for (const project of saved.projects) {
      if (!needsGenerationCheck(project)) continue;
      const previous = { ...project, jobs: project.jobs.map(job => ({ ...job })), announced: [...project.announced], ignoredJobIds: [...(project.ignoredJobIds ?? [])] };
      try {
        const result = await checkGeneration(api, project);
        if (!await stillCurrent()) return BackgroundTask.BackgroundTaskResult.Success;
        Object.assign(project, result.watched);
        saved.recent = appendRecentCompletions(saved.recent ?? [], result.completions);
        await save();
        setRecentCompletions(saved.owner, saved.recent);
        for (const completion of result.completions) {
          if (!await stillCurrent()) return BackgroundTask.BackgroundTaskResult.Success;
          try { await deliver(completion, saved.owner, () => current && (!configured || runtime.currentOwner() === saved.owner), undefined, stillCurrent); }
          catch {
            project.announced = project.announced.filter(id => !completion.jobIds.includes(id));
            if (await stillCurrent()) await save();
          }
        }
      } catch (error) {
        if ((error as { status?: number }).status === 404) project.jobs = [];
        else if ((error as { status?: number }).status === 401) return BackgroundTask.BackgroundTaskResult.Success;
        else {
          Object.assign(project, previous);
          if (await stillCurrent()) await save();
          throw error;
        }
      }
    }
    if (await stillCurrent()) await save();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (error) {
    return (error as { status?: number }).status === 404 ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function configureNotifications(value: NotificationSession | null, onComplete?: CompletionListener): Promise<void> {
  configured = true;
  const previousOwner = runtime.currentOwner();
  const nextOwner = value ? notificationOwner(value) : undefined;
  if (nextOwner !== permissionOwner) { permissionAsked = false; permissionOwner = nextOwner; }
  await runtime.configure(value, onComplete);
  try {
    if (!value) {
      if (runtime.currentOwner()) return;
      if (await TaskManager.isTaskRegisteredAsync(TASK)) await BackgroundTask.unregisterTaskAsync(TASK);
      if (!runtime.currentOwner()) await Notifications.dismissAllNotificationsAsync();
      return;
    }
    if (!runtime.isCurrent(value)) return;
    if (previousOwner && previousOwner !== nextOwner) await Notifications.dismissAllNotificationsAsync();
    if (!runtime.isCurrent(value)) return;
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync(CHANNEL, { name: '穿搭生成完成', importance: AndroidImportance.DEFAULT, sound: null, enableVibrate: false });
    if (!runtime.isCurrent(value)) return;
    if (await BackgroundTask.getStatusAsync() === BackgroundTask.BackgroundTaskStatus.Available && !await TaskManager.isTaskRegisteredAsync(TASK) && runtime.isCurrent(value)) await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 15 });
  } catch { /* Unavailable OS services do not affect generation or in-app notices. */ }
}

export function observeGeneration(id: string, title: string, state: ProjectState): void {
  const owner = runtime.currentOwner();
  if (!owner) return;
  void runtime.observe(id, title, state).then(async () => {
    if (runtime.currentOwner() !== owner || permissionAsked || (!(state.mode === 'auto' && state.auto?.active) && (!state.active_jobs.length || ['brief', 'direction', 'script'].includes(state.stage)))) return;
    if (!isForeground()) return;
    permissionAsked = true;
    const permission = await Notifications.getPermissionsAsync();
    if (runtime.currentOwner() === owner && !permission.granted && permission.canAskAgain && isForeground()) await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: false } });
  }).catch(() => undefined);
}
export const pollGenerations = runtime.poll;

export function listenNotificationTap(callback: (id: string) => void): () => void {
  let alive = true;
  const handle = (response: Notifications.NotificationResponse) => {
    const owner = runtime.currentOwner();
    if (!alive || !owner) return;
    const id = notificationProject(response.notification.request.content.data, owner);
    if (id) { callback(id); void Notifications.clearLastNotificationResponseAsync().catch(() => undefined); }
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handle);
  void Notifications.getLastNotificationResponseAsync().then(response => { if (response) handle(response); }).catch(() => undefined);
  return () => { alive = false; subscription.remove(); };
}
