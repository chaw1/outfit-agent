/** Wire types shared by REST responses and the message event stream. */
export type Stage = 'brief' | 'direction' | 'script' | 'images' | 'note' | 'video' | 'done';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type AssetKind = 'garment' | 'model' | 'reference';

export interface User {
  id: string;
  username: string;
  nickname: string;
  created_at: string;
}

export interface AuthResponse { token: string; user: User }
export interface LoginInput { username: string; password: string }
export interface RegisterInput extends LoginInput { nickname?: string }

export interface Asset {
  id: string;
  kind: AssetKind;
  url: string;
  width: number;
  height: number;
  mime: string;
  created_at: string;
  source: 'upload' | 'generated';
  parent_id?: string;
  prompt?: string;
}

export interface Project {
  id: string;
  title: string;
  brand: string;
  brief: string;
  stage: Stage;
  cover_url?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput {
  title: string;
  brand: string;
  brief: string;
  garment_asset_ids: string[];
  model_asset_id?: string;
}

export interface Garment {
  asset_id: string;
  url: string;
  category: string;
  color: string;
  material: string;
  style_tags: string[];
}

export interface Direction {
  id: string;
  name: string;
  scene: string;
  mood: string;
  palette: string | string[];
  why: string;
  sample_title: string;
  preview_url?: string;
  preview_status?: JobStatus;
}

export interface ScriptShot {
  id: string;
  scene: string;
  outfit_asset_ids: string[];
  pose: string;
  camera: string;
  caption: string;
}

export interface ScriptData {
  status: 'draft' | 'confirmed';
  title_ideas: string[];
  cover: { scene: string; pose: string; text_overlay: string };
  shots: ScriptShot[];
  video: { prompt: string; duration: number };
}

export interface ScriptVersion {
  version: number;
  checkpoint_id: string;
  created_at: string;
  summary: string;
  current: boolean;
}

export interface OutfitImage {
  id: string;
  shot_id: string;
  url?: string;
  status: JobStatus;
  version: number;
  parent_id?: string;
  instruction?: string;
  error?: string;
  fidelity?: { score: number; diffs: string[]; auto_fixed: boolean };
  script_version?: number;
}

export type Image = OutfitImage;
export interface NoteData {
  title: string;
  body: string;
  tags: string[];
  image_ids: string[];
  cost_cny?: number;
  ai_label?: string;
}
export interface VideoData { status: JobStatus; url?: string; poster_url?: string; job_id?: string }

export type Card =
  | { id: string; type: 'garments'; items: Garment[] }
  | { id: string; type: 'directions'; options: Direction[] }
  | ({ id: string; type: 'script' } & ScriptData)
  | { id: string; type: 'images'; items: OutfitImage[] }
  | ({ id: string; type: 'note' } & NoteData)
  | ({ id: string; type: 'video' } & VideoData);

export type Action =
  | { type: 'choose_direction'; direction_id: string }
  | { type: 'confirm_script' }
  | { type: 'edit_image'; image_id: string; instruction: string }
  | { type: 'approve_images'; image_ids: string[] }
  | { type: 'confirm_video'; image_id: string }
  | { type: 'restore_script'; checkpoint_id: string };

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cards: Card[];
  action?: Action;
  created_at: string;
}

export interface Job {
  id: string;
  project_id: string;
  kind: 'image' | 'edit' | 'video';
  status: JobStatus;
  result_asset_id?: string;
  url?: string;
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface PendingAction {
  type: 'choose_direction' | 'confirm_script' | 'confirm_video';
  prompt: string;
}

export interface ProjectState {
  stage: Stage;
  garments: Garment[];
  directions: Direction[];
  chosen_direction_id?: string;
  script?: ScriptData;
  images: OutfitImage[];
  note?: NoteData;
  video?: VideoData;
  active_jobs: Job[];
  pending_action?: PendingAction | null;
  cost_cny?: number;
  last_message_id?: string | null;
  script_versions?: ScriptVersion[];
}

export interface SendMessageInput { text?: string; action?: Action }
export interface ErrorData { code: string; message: string }
export interface DoneData { message_id: string }

export type StreamEvent =
  | { type: 'token'; data: { delta: string } }
  | { type: 'card'; data: Card }
  | { type: 'job'; data: Job }
  | { type: 'done'; data: DoneData }
  | { type: 'error'; data: ErrorData };

export interface HealthResponse {
  ok: true;
  version: string;
  providers: { text: string; vision: string; image: string; video: string; mock: boolean };
}
