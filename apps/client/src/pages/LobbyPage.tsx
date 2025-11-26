import { useState, useEffect } from 'react'
import { RoomControls } from '../components/RoomControls'
import type { SyncPlayService } from '../services/SyncPlayService'
import type { ServerConfig, RoomInfo } from '../types'
import '../App.css'

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
    <div className="join-container">
      <div className="join-content">
        <h1>SyncPlay - Room Lobby</h1>
        
        {joinError && (
          <div className="compatibility-error">
            <strong>Error</strong>
            <p>{joinError}</p>
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
    </div>
  )
}
