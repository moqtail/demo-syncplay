export interface FragmentRange {
  startGroupId: number;
  startObjectId: number;
  endGroupId: number;
  endObjectId: number;
}

export interface RequestState {
  isLoading: boolean;
  error: string | null;
}

// ============ SYNC PLAYBACK TYPES ============

export type UserRole = 'leader' | 'follower';

export interface SyncConfig {
  deltaThresholdSeconds: number;      // Sync tolerance (e.g., 0.5s)
  leaderBroadcastIntervalMs: number;  // How often leader sends updates (e.g., 50ms)
  wsUrl: string;                      // WebSocket server URL
  wsReconnectDelayMs: number;         // Reconnection delay
}

export interface PlaybackPosition {
  timestamp: number;
  groupId: number;
  objectId: number;
  isPlaying: boolean;
}

// WebSocket Messages (matching server types)
export interface JoinRoomMessage {
  type: 'join-as-leader' | 'join-as-follower';
  roomId: string;
  userName: string;
  mediaTrackName: string;
}

export interface VideoItem {
  id: string;
  name: string;
  trackName: string;
}

export interface ServerConfig {
  maxRoomCount: number;
  maxUsersPerRoom: number;
  videoCatalog: VideoItem[];
}

export interface RoomInfo {
  id: string;
  hasLeader: boolean;
  userCount: number;
  videoName: string;
  leaderName: string | null;
}

export interface GetRoomsMessage {
  type: 'get-rooms';
}

export interface GetConfigMessage {
  type: 'get-config';
}

export interface RoomsListMessage {
  type: 'rooms-list';
  rooms: RoomInfo[];
}

export interface ConfigMessage {
  type: 'config';
  config: ServerConfig;
}

export interface SyncUpdateMessage {
  type: 'sync-update';
  timestamp: number;
  groupId: number;
  objectId: number;
  isPlaying: boolean;
}

export interface PlaybackControlMessage {
  type: 'playback-control';
  action: 'play' | 'pause' | 'seek';
  timestamp: number;
  groupId: number;
  objectId: number;
  seekTarget?: number;
}

export interface RoomStateMessage {
  type: 'room-state';
  roomId: string;
  userId: string;
  role: UserRole;
  leaderId: string | null;
  leaderName: string | null;
  users: Array<{
    id: string;
    name: string;
    role: UserRole;
  }>;
  totalUsers: number;
  mediaName: string;
  currentPlaybackState: PlaybackPosition | null;
}

export interface UserJoinedMessage {
  type: 'user-joined';
  userId: string;
  userName: string;
  role: UserRole;
  totalUsers: number;
}

export interface UserLeftMessage {
  type: 'user-left';
  userId: string;
  userName: string;
  totalUsers: number;
  newLeaderId?: string;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type ServerMessage =
  | SyncUpdateMessage
  | PlaybackControlMessage
  | RoomStateMessage
  | UserJoinedMessage
  | UserLeftMessage
  | ErrorMessage
  | RoomsListMessage
  | ConfigMessage;