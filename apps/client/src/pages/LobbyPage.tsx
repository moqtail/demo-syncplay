import { useState, useEffect } from 'react'
import { RoomControls } from '../components/RoomControls'
import type { SyncPlayService } from '../services/SyncPlayService'
import type { ServerConfig, RoomInfo } from '../types'

interface LobbyPageProps {
  syncService: SyncPlayService | null
  serverConfig: ServerConfig | null
  rooms: RoomInfo[]
  onRequestRooms: () => void
  onRequestConfig: () => void
  onJoinRoom: (roomId: string, role: 'leader' | 'follower', userName: string, videoId: string) => void
}

export default function LobbyPage({
  syncService,
  serverConfig,
  rooms,
  onRequestRooms,
  onRequestConfig,
  onJoinRoom,
}: LobbyPageProps) {
  const [joinError, setJoinError] = useState<string | null>(null)

  useEffect(() => {
    if (syncService && syncService.isConnected()) {
      onRequestConfig()
      onRequestRooms()
    }
  }, [syncService, onRequestConfig, onRequestRooms])

  const handleJoinRoom = async (
    roomId: string,
    role: 'leader' | 'follower',
    userName: string,
    videoId: string
  ) => {
    try {
      setJoinError(null)
      await onJoinRoom(roomId, role, userName, videoId)
    } catch (err) {
      console.error('Join room failed', err)
      setJoinError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      <h1>SyncPlay - Room Lobby</h1>
      {joinError && (
        <div
          style={{
            padding: '10px',
            marginBottom: '20px',
            backgroundColor: '#fee',
            border: '1px solid #c00',
            borderRadius: '4px',
            color: '#c00',
          }}
        >
          {joinError}
        </div>
      )}
      <RoomControls
        config={serverConfig}
        rooms={rooms}
        onJoinRoom={handleJoinRoom}
        onRequestRooms={onRequestRooms}
        onRequestConfig={onRequestConfig}
      />
    </div>
  )
}
