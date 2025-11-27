/**
 * Copyright 2025 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {
  ServerMessage,
  SyncUpdateMessage,
  PlaybackControlMessage,
  JoinRoomMessage,
  RoomStateMessage,
  ErrorMessage,
  SyncConfig,
  GetRoomsMessage,
  GetConfigMessage,
  RoomsListMessage,
  ConfigMessage,
} from '../types';

type MessageHandler = (message: ServerMessage) => void;
type RoomStateHandler = (state: RoomStateMessage) => void;
type ErrorHandler = (error: ErrorMessage) => void;
type RoomsListHandler = (rooms: RoomsListMessage) => void;
type ConfigHandler = (config: ConfigMessage) => void;

export class SyncPlayService {
  private ws: WebSocket | null = null;
  private config: SyncConfig;
  private messageHandlers: Set<MessageHandler> = new Set();
  private roomStateHandlers: Set<RoomStateHandler> = new Set();
  private errorHandlers: Set<ErrorHandler> = new Set();
  private roomsListHandlers: Set<RoomsListHandler> = new Set();
  private configHandlers: Set<ConfigHandler> = new Set();
  private reconnectTimeout: number | null = null;
  private shouldReconnect = false;
  private lastJoinMessage: JoinRoomMessage | null = null;

  constructor(config: SyncConfig) {
    this.config = config;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        console.log('[SyncPlay] Connecting to:', this.config.wsUrl);
        this.ws = new WebSocket(this.config.wsUrl);

        this.ws.onopen = () => {
          console.log('[SyncPlay] Connected to sync server');
          this.shouldReconnect = true;

          if (this.lastJoinMessage) {
            console.log('[SyncPlay] Reconnected, rejoining room...');
            this.send(this.lastJoinMessage);
          }

          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message: ServerMessage = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            console.error('[SyncPlay] Error parsing message:', error);
          }
        };

        this.ws.onerror = (event) => {
          console.error('[SyncPlay] WebSocket error:', event);
          reject(new Error('WebSocket connection error'));
        };

        this.ws.onclose = () => {
          console.log('[SyncPlay] Disconnected from sync server');
          this.ws = null;

          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.lastJoinMessage = null;
    console.log('[SyncPlay] Disconnected');
  }

  joinRoom(
    roomId: string,
    role: 'leader' | 'follower',
    userName: string,
    mediaTrackName: string
  ): void {
    const message: JoinRoomMessage = {
      type: role === 'leader' ? 'join-as-leader' : 'join-as-follower',
      roomId,
      userName,
      mediaTrackName,
    };

    this.lastJoinMessage = message;
    this.send(message);
  }

  sendSyncUpdate(timestamp: number, groupId: number, objectId: number, isPlaying: boolean): void {
    const message: SyncUpdateMessage = {
      type: 'sync-update',
      timestamp,
      groupId,
      objectId,
      isPlaying,
    };
    this.send(message);
  }

  sendPlaybackControl(
    action: 'play' | 'pause' | 'seek',
    timestamp: number,
    groupId: number,
    objectId: number,
    seekTarget?: number
  ): void {
    const message: PlaybackControlMessage = {
      type: 'playback-control',
      action,
      timestamp,
      groupId,
      objectId,
      seekTarget,
    };
    this.send(message);
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onRoomState(handler: RoomStateHandler): () => void {
    this.roomStateHandlers.add(handler);
    return () => this.roomStateHandlers.delete(handler);
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onRoomsList(handler: RoomsListHandler): () => void {
    this.roomsListHandlers.add(handler);
    return () => this.roomsListHandlers.delete(handler);
  }

  onConfig(handler: ConfigHandler): () => void {
    this.configHandlers.add(handler);
    return () => this.configHandlers.delete(handler);
  }

  requestRoomsList(): void {
    const message: GetRoomsMessage = {
      type: 'get-rooms',
    };
    this.send(message);
  }

  requestConfig(): void {
    const message: GetConfigMessage = {
      type: 'get-config',
    };
    this.send(message);
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private send(message: GetRoomsMessage | GetConfigMessage | JoinRoomMessage | SyncUpdateMessage | PlaybackControlMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[SyncPlay] Cannot send message, not connected');
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('[SyncPlay] Error sending message:', error);
    }
  }

  private handleMessage(message: ServerMessage): void {
    console.log('[SyncPlay] Received:', message.type);

    this.messageHandlers.forEach((handler) => {
      try {
        handler(message);
      } catch (error) {
        console.error('[SyncPlay] Error in message handler:', error);
      }
    });

    switch (message.type) {
      case 'room-state':
        this.roomStateHandlers.forEach((handler) => {
          try {
            handler(message);
          } catch (error) {
            console.error('[SyncPlay] Error in room state handler:', error);
          }
        });
        break;

      case 'error':
        this.errorHandlers.forEach((handler) => {
          try {
            handler(message);
          } catch (error) {
            console.error('[SyncPlay] Error in error handler:', error);
          }
        });
        break;

      case 'rooms-list':
        this.roomsListHandlers.forEach((handler) => {
          try {
            handler(message);
          } catch (error) {
            console.error('[SyncPlay] Error in rooms list handler:', error);
          }
        });
        break;

      case 'config':
        this.configHandlers.forEach((handler) => {
          try {
            handler(message);
          } catch (error) {
            console.error('[SyncPlay] Error in config handler:', error);
          }
        });
        break;

      case 'sync-update':
      case 'playback-control':
      case 'user-joined':
      case 'user-left':
        // These are handled by general message handlers
        break;

      default:
        console.warn('[SyncPlay] Unknown message type:', message);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout !== null) return;

    console.log(`[SyncPlay] Reconnecting in ${this.config.wsReconnectDelayMs}ms...`);
    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect().catch((error) => {
        console.error('[SyncPlay] Reconnection failed:', error);
      });
    }, this.config.wsReconnectDelayMs);
  }
}
