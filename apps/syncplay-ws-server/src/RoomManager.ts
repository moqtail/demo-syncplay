import { v4 as uuidv4 } from 'uuid';
import type {
  Room,
  User,
  UserRole,
  PlaybackState,
  RoomStateMessage,
  UserJoinedMessage,
  UserLeftMessage,
  ErrorMessage,
  SyncUpdateMessage,
  PlaybackControlMessage,
  RoomInfo,
  ServerConfig,
} from './types';

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private config: ServerConfig;
  private allConnections: Set<any> = new Set();

  constructor(config: ServerConfig) {
    this.config = config;
  }

  addConnection(ws: any): void {
    this.allConnections.add(ws);
  }

  removeConnection(ws: any): void {
    this.allConnections.delete(ws);
  }

  private broadcastRoomListUpdate(): void {
    const roomsList = this.getRoomsList();
    const message = {
      type: 'rooms-list',
      rooms: roomsList,
    };

    this.allConnections.forEach((ws) => {
      try {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(message));
        }
      } catch (error) {
        console.error('[RoomManager] Error broadcasting room list:', error);
      }
    });
  }

  private getOrCreateRoom(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        id: roomId,
        leaderId: null,
        users: new Map(),
        mediaName: 'demo',
        currentPlaybackState: null,
      };
      this.rooms.set(roomId, room);
      console.log(`[RoomManager] Created new room: ${roomId}`);
    }
    return room;
  }

  joinRoom(
    roomId: string,
    role: UserRole,
    userName: string,
    mediaTrackName: string,
    ws: any
  ): { success: boolean; userId?: string; error?: ErrorMessage } {
    const roomExists = this.rooms.has(roomId);
    
    if (!roomExists && this.rooms.size >= this.config.maxRoomCount) {
      return {
        success: false,
        error: {
          type: 'error',
          code: 'MAX_ROOMS_REACHED',
          message: 'Maximum number of rooms reached. Please join an existing room.',
        },
      };
    }

    const room = this.getOrCreateRoom(roomId);

    if (room.users.size >= this.config.maxUsersPerRoom) {
      return {
        success: false,
        error: {
          type: 'error',
          code: 'ROOM_FULL',
          message: 'This room is full. Please join a different room.',
        },
      };
    }

    if (role === 'leader' && room.leaderId !== null) {
      return {
        success: false,
        error: {
          type: 'error',
          code: 'LEADER_EXISTS',
          message: 'A leader already exists in this room. Please join as a follower.',
        },
      };
    }

    if (role === 'follower' && room.leaderId === null && room.users.size > 0) {
      return {
        success: false,
        error: {
          type: 'error',
          code: 'NO_LEADER',
          message: 'This room has no leader. Cannot join as follower.',
        },
      };
    }

    const userId = uuidv4();
    const user: User = {
      id: userId,
      name: userName,
      role,
      roomId,
      mediaTrackName,
      ws,
    };

    room.users.set(userId, user);

    if (role === 'leader') {
      room.leaderId = userId;
      room.mediaName = mediaTrackName;
      console.log(`[RoomManager] User ${userName} joined room ${roomId} as LEADER`);
    } else {
      console.log(`[RoomManager] User ${userName} joined room ${roomId} as FOLLOWER`);
    }

    this.sendRoomState(roomId, userId);

    this.broadcastToRoom(roomId, {
      type: 'user-joined',
      userId,
      userName,
      role,
      totalUsers: room.users.size,
    } as UserJoinedMessage, userId);

    this.broadcastRoomListUpdate();

    return { success: true, userId };
  }

  leaveRoom(roomId: string, userId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const user = room.users.get(userId);
    if (!user) return;

    const userName = user.name;
    const wasLeader = room.leaderId === userId;

    room.users.delete(userId);
    console.log(`[RoomManager] User ${userName} left room ${roomId}`);

    if (room.users.size === 0) {
      this.rooms.delete(roomId);
      console.log(`[RoomManager] Room ${roomId} is empty, deleted`);
      this.broadcastRoomListUpdate();
      return;
    }

    let newLeaderId: string | null = null;

    if (wasLeader) {
      const followers = Array.from(room.users.values()).filter(u => u.role === 'follower');
      if (followers.length > 0) {
        const randomFollower = followers[Math.floor(Math.random() * followers.length)];
        randomFollower.role = 'leader';
        room.leaderId = randomFollower.id;
        newLeaderId = randomFollower.id;
        console.log(`[RoomManager] Leader left room ${roomId}, promoted ${randomFollower.name} to leader`);
      } else {
        room.leaderId = null;
        console.log(`[RoomManager] Leader left room ${roomId}, no followers to promote`);
      }
    }

    this.broadcastToRoom(roomId, {
      type: 'user-left',
      userId,
      userName,
      totalUsers: room.users.size,
      newLeaderId: newLeaderId ?? undefined,
    } as UserLeftMessage);

    if (newLeaderId) {
      room.users.forEach((u) => {
        this.sendRoomState(roomId, u.id);
      });
    }

    this.broadcastRoomListUpdate();
  }

  handleSyncUpdate(roomId: string, userId: string, syncData: SyncUpdateMessage): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (room.leaderId !== userId) {
      console.warn(`[RoomManager] Non-leader ${userId} tried to send sync update in room ${roomId}`);
      return;
    }

    room.currentPlaybackState = {
      timestamp: syncData.timestamp,
      groupId: syncData.groupId,
      objectId: syncData.objectId,
      isPlaying: syncData.isPlaying,
      lastUpdateTime: Date.now(),
    };

    this.broadcastToRoom(roomId, syncData, userId);
  }

  handlePlaybackControl(roomId: string, userId: string, controlData: PlaybackControlMessage): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (room.leaderId !== userId) {
      console.warn(`[RoomManager] Non-leader ${userId} tried to send playback control in room ${roomId}`);
      return;
    }

    const isPlaying = controlData.action === 'play';
    room.currentPlaybackState = {
      timestamp: controlData.timestamp,
      groupId: controlData.groupId,
      objectId: controlData.objectId,
      isPlaying,
      lastUpdateTime: Date.now(),
    };

    this.broadcastToRoom(roomId, controlData, userId);
  }

  private sendRoomState(roomId: string, userId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const user = room.users.get(userId);
    if (!user) return;

    const leader = room.leaderId ? room.users.get(room.leaderId) : null;

    const roomState: RoomStateMessage = {
      type: 'room-state',
      roomId,
      userId,
      role: user.role,
      leaderId: room.leaderId,
      leaderName: leader?.name ?? null,
      users: Array.from(room.users.values()).map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
      })),
      totalUsers: room.users.size,
      mediaName: room.mediaName,
      currentPlaybackState: room.currentPlaybackState,
    };

    this.sendToUser(user.ws, roomState);
  }

  private broadcastToRoom(roomId: string, message: any, excludeUserId?: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.users.forEach((user) => {
      if (excludeUserId && user.id === excludeUserId) return;
      this.sendToUser(user.ws, message);
    });
  }

  private sendToUser(ws: any, message: any): void {
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('[RoomManager] Error sending message:', error);
    }
  }
  
  getRoomInfo(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getAllRooms(): Map<string, Room> {
    return this.rooms;
  }

  getRoomsList(): RoomInfo[] {
    const roomsList: RoomInfo[] = [];
    this.rooms.forEach((room) => {
      const leader = room.leaderId ? room.users.get(room.leaderId) : null;
      roomsList.push({
        id: room.id,
        hasLeader: room.leaderId !== null,
        userCount: room.users.size,
        videoName: room.mediaName,
        leaderName: leader?.name ?? null,
      });
    });
    return roomsList;
  }

  getConfig(): ServerConfig {
    return this.config;
  }
}
