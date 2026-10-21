/** Wire types shared by REST responses and the message event stream. */
export type Stage = 'brief' | 'direction' | 'script' | 'images' | 'note' | 'video' | 'done';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type AssetKind = 'garment' | 'model' | 'reference';
export type ProjectMode = 'guided' | 'auto';
export type AutoStep = 'directions' | 'script' | 'images' | 'note' | 'video' | 'done';

export interface ProjectProgress {
  status: 'waiting_you' | 'generating' | 'ready' | 'done' | 'failed' | 'idle';
  label: string;
  running: number;
  total: number;
  updated_at: string;
}

export interface AutoState {
  active: boolean;
  step: AutoStep;
  label: string;
  started_at: string;
  estimate_points: number;
}

export interface AutoQuote {
  estimate_points: number;
  breakdown: { label: string; points: number }[];
}

export interface UpdateProjectModeInput { mode: 'guided' }

export interface UserProfile {
  model_asset_ids: string[];
  height_cm?: number;
  body_notes?: string;
  style_notes?: string;
}

export interface UpdateMeInput {
  nickname?: string;
  profile?: Omit<Partial<UserProfile>, 'height_cm'> & { height_cm?: number | null };
}

export interface User {
  id: string;
  username: string;
  nickname: string;
  created_at: string;
  tier?: string;
  daily_budget_cny?: number;
  today_cost_cny?: number;
  daily_budget_points?: number;
  today_cost_points?: number;
  profile?: UserProfile;
}

export type LegalKind = 'terms' | 'privacy' | 'disclaimer';
export interface LegalSummary { kind: LegalKind; title: string; version: string }
export interface LegalDocument extends LegalSummary { markdown: string }

export interface AuthResponse { token: string; user: User; recovery_code?: string }
export interface RecoveryAuthResponse extends AuthResponse { recovery_code: string }
export interface ChangePasswordInput { current_password: string; new_password: string }
export interface RecoverInput { username: string; recovery_code: string; new_password: string }
export interface LoginInput { username: string; password: string }
export interface RegisterInput extends LoginInput { nickname?: string; agreed_legal_version?: string }

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
  reference_asset_ids?: string[];
  mode?: ProjectMode;
  style_tags?: string[];
  progress?: ProjectProgress;
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
  reference_asset_ids?: string[];
  mode?: ProjectMode;
  style_tags?: string[];
}

export interface Garment {
  asset_id: string;
  url: string;
  category: string;
  color: string;
  material: string;
  style_tags: string[];
}

export interface ReferenceImage {
  asset_id: string;
  url: string;
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
  recommended?: boolean;
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

export interface ImagePoint { x: number; y: number }
export interface ImageRegion extends ImagePoint { w: number; h: number }
export interface ImageMaskStrokes { brush: number; strokes: ImagePoint[][] }
export interface EditCheck { passed: boolean; reason: string }

export interface OutfitImage {
  id: string;
  shot_id: string;
  url?: string;
  status: JobStatus;
  version: number;
  parent_id?: string;
  anchor_id?: string;
  instruction?: string;
  error?: string;
  fidelity?: { score: number; diffs: string[]; auto_fixed: boolean; person_score?: number; anchor_score?: number };
  script_version?: number;
  region?: ImageRegion;
  edit_check?: EditCheck;
}

export type Image = OutfitImage;
export interface NoteData {
  title: string;
  body: string;
  tags: string[];
  image_ids: string[];
  accepted_unverified_ids?: string[];
  cost_cny?: number;
  cost_points?: number;
  ai_label?: string;
}
export interface VideoData { status: JobStatus; url?: string; poster_url?: string; job_id?: string }

export type Card = (
  | { id: string; type: 'garments'; items: Garment[] }
  | { id: string; type: 'references'; items: ReferenceImage[] }
  | { id: string; type: 'directions'; options: Direction[]; regenerate_estimate_cny?: number; regenerate_estimate_points?: number }
  | ({ id: string; type: 'script' } & ScriptData)
  | { id: string; type: 'images'; items: OutfitImage[] }
  | ({ id: string; type: 'note' } & NoteData)
  | ({ id: string; type: 'video' } & VideoData)
) & { cost_cny?: number; cost_points?: number };

export type Action =
  | { type: 'choose_direction'; direction_id: string }
  | { type: 'confirm_script' }
  | { type: 'edit_image'; image_id: string; instruction: string; region?: ImageRegion; mask_strokes?: ImageMaskStrokes; attempt?: string }
  | { type: 'approve_images'; image_ids: string[]; accept_unverified?: string[] }
  | { type: 'confirm_video'; image_id: string }
  | { type: 'restore_script'; checkpoint_id: string }
  | { type: 'regenerate_reply'; message_id: string };

export interface MessageTrace {
  tool: 'chat' | 'propose_directions' | 'write_script' | 'revise_script' | 'edit_image' | 'write_note' | 'generate_images' | 'generate_video' | 'restore_script';
  model: string;
  duration_ms: number;
  cost_cny: number;
  cost_points?: number;
  refs: string[];
  steps: { label: string; duration_ms: number }[];
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cards: Card[];
  action?: Action;
  refs?: string[];
  can_regenerate?: boolean;
  trace?: MessageTrace;
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
  reused?: boolean;
}

export interface PendingAction {
  type: 'choose_direction' | 'confirm_script' | 'confirm_video' | 'edit_image';
  prompt: string;
  estimated_cost_cny?: number;
  estimated_cost_points?: number;
  reused?: boolean;
}

export interface ProjectBudget {
  tier: string;
  daily_budget_cny: number;
  today_cost_cny: number;
  remaining_cny: number;
  daily_budget_points?: number;
  today_cost_points?: number;
  remaining_points?: number;
}

export interface ProjectState {
  stage: Stage;
  mode?: ProjectMode;
  style_tags?: string[];
  auto?: AutoState | null;
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
  cost_points?: number;
  last_message_id?: string | null;
  script_versions?: ScriptVersion[];
  budget?: ProjectBudget;
}

export interface SendMessageInput { text?: string; action?: Action; refs?: string[] }
export interface ErrorData { code: string; message: string }
export interface DoneData { message_id: string; reused?: boolean }

export type StreamEvent =
  | { type: 'token'; data: { delta: string } }
  | { type: 'card'; data: Card }
  | { type: 'job'; data: Job }
  | { type: 'trace'; data: MessageTrace }
  | { type: 'done'; data: DoneData }
  | { type: 'error'; data: ErrorData };

export interface HealthResponse {
  ok: true;
  version: string;
  providers: { text: string; vision: string; image: string; video: string; mock: boolean };
}
