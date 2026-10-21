import { useRouter } from 'expo-router';
import { AssetLibrary } from '../components/AssetLibrary';
import { Header, Page } from '../components/ui';

export default function Assets() {
  const router = useRouter();
  return <Page tone="studio"><Header title="素材库" onBack={() => router.canGoBack() ? router.back() : router.replace('/')} /><AssetLibrary /></Page>;
}
