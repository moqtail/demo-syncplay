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

import { WebSocketServer, WebSocket } from 'ws';
import { RoomManager } from './RoomManager';
import appSettings from './appsettings.json';
import type {
  ClientMessage,
  JoinRoomMessage,
  SyncUpdateMessage,
  PlaybackControlMessage,
  ErrorMessage,
  ServerConfig,
  RoomsListMessage,
  ConfigMessage,
} from './types';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;

export const serverConfig: ServerConfig = {
  maxRoomCount: appSettings.serverConfig.maxRoomCount,
  maxUsersPerRoom: appSettings.serverConfig.maxUsersPerRoom,
  videoCatalog: appSettings.serverConfig.videoCatalog,
};

const roomManager = new RoomManager(serverConfig);

const connectionToUserId = new Map<WebSocket, { userId: string; roomId: string }>();

const wss = new WebSocketServer({ port: PORT });

console.log(`SyncPlay WebSocket Server started on port ${PORT}`);
console.log(`Max rooms: ${serverConfig.maxRoomCount}, Max users per room: ${serverConfig.maxUsersPerRoom}`);

wss.on('connection', (ws: WebSocket) => {
  console.log('New WebSocket connection established');

  roomManager.addConnection(ws);

  ws.on('message', (data: Buffer) => {
    try {
      const message: ClientMessage = JSON.parse(data.toString());
      handleMessage(ws, message);
    } catch (error) {
      console.error('Error parsing message:', error);
      sendError(ws, 'PARSE_ERROR', 'Invalid message format');
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    handleDisconnect(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    handleDisconnect(ws);
  });
});

function handleMessage(ws: WebSocket, message: ClientMessage): void {
  console.log('Received message:', message.type);

  switch (message.type) {
    case 'join-as-leader':
    case 'join-as-follower':
      handleJoinRoom(ws, message);
      break;

    case 'sync-update':
      handleSyncUpdate(ws, message);
      break;

    case 'playback-control':
      handlePlaybackControl(ws, message);
      break;

    case 'get-rooms':
      handleGetRooms(ws);
      break;

    case 'get-config':
      handleGetConfig(ws);
      break;

    default:
      console.warn('Unknown message type:', (message as any).type);
      sendError(ws, 'UNKNOWN_MESSAGE', 'Unknown message type');
  }
}

function handleJoinRoom(ws: WebSocket, message: JoinRoomMessage): void {
  const role = message.type === 'join-as-leader' ? 'leader' : 'follower';
  const { roomId, userName, mediaTrackName } = message;

  console.log(`User "${userName}" attempting to join room "${roomId}" as ${role.toUpperCase()}`);

  const result = roomManager.joinRoom(roomId, role, userName, mediaTrackName, ws);

  if (!result.success) {
    console.log(`Join failed: ${result.error?.message}`);
    sendError(ws, result.error!.code, result.error!.message);
    return;
  }

  connectionToUserId.set(ws, { userId: result.userId!, roomId });
  console.log(`User "${userName}" successfully joined room "${roomId}" as ${role.toUpperCase()}`);
}

function handleSyncUpdate(ws: WebSocket, message: SyncUpdateMessage): void {
  const connection = connectionToUserId.get(ws);
  if (!connection) {
    console.warn('Sync update from unknown connection');
    return;
  }

  roomManager.handleSyncUpdate(connection.roomId, connection.userId, message);
}

function handlePlaybackControl(ws: WebSocket, message: PlaybackControlMessage): void {
  const connection = connectionToUserId.get(ws);
  if (!connection) {
    console.warn('Playback control from unknown connection');
    return;
  }

  console.log(`Playback control: ${message.action} at ${message.timestamp.toFixed(2)}s`);
  roomManager.handlePlaybackControl(connection.roomId, connection.userId, message);
}

function handleGetRooms(ws: WebSocket): void {
  const rooms = roomManager.getRoomsList();
  const response: RoomsListMessage = {
    type: 'rooms-list',
    rooms,
  };
  
  try {
    ws.send(JSON.stringify(response));
  } catch (err) {
    console.error('Error sending rooms list:', err);
  }
}

function handleGetConfig(ws: WebSocket): void {
  const config = roomManager.getConfig();
  const response: ConfigMessage = {
    type: 'config',
    config,
  };
  
  try {
    ws.send(JSON.stringify(response));
  } catch (err) {
    console.error('Error sending config:', err);
  }
}

function handleDisconnect(ws: WebSocket): void {
  const connection = connectionToUserId.get(ws);
  if (connection) {
    console.log(`User disconnecting from room "${connection.roomId}"`);
    roomManager.leaveRoom(connection.roomId, connection.userId);
    connectionToUserId.delete(ws);
  }
  
  roomManager.removeConnection(ws);
}

function sendError(ws: WebSocket, code: string, message: string): void {
  const error: ErrorMessage = {
    type: 'error',
    code,
    message,
  };

  try {
    ws.send(JSON.stringify(error));
  } catch (err) {
    console.error('Error sending error message:', err);
  }
}
