import { useState, useEffect } from 'react';
import type { UserRole, RoomInfo, ServerConfig } from '../types';

interface RoomControlsProps {
  onJoinRoom: (roomId: string, role: UserRole, userName: string, videoId: string) => void;
  disabled?: boolean;
  onRequestRooms: () => void;
  onRequestConfig: () => void;
  rooms: RoomInfo[];
  config: ServerConfig | null;
}

export function RoomControls({ 
  onJoinRoom, 
  disabled = false, 
  onRequestRooms, 
  onRequestConfig,
  rooms,
  config
}: RoomControlsProps) {
  const [userName, setUserName] = useState('');
  const [newRoomId, setNewRoomId] = useState('');
  const [selectedVideo, setSelectedVideo] = useState<string>('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  useEffect(() => {
    onRequestRooms();
    onRequestConfig();
  }, [onRequestRooms, onRequestConfig]);

  useEffect(() => {
    if (config && config.videoCatalog.length > 0) {
      if (!selectedVideo || !config.videoCatalog.find(v => v.id === selectedVideo)) {
        setSelectedVideo(config.videoCatalog[0].id);
      }
    }
  }, [config, selectedVideo]);

  const handleCreateRoom = () => {
    if (!newRoomId.trim() || !userName.trim() || !selectedVideo) {
      alert('Please enter room name, your name, and select a video');
      return;
    }
    onJoinRoom(newRoomId.trim(), 'leader', userName.trim(), selectedVideo);
    setShowCreateForm(false);
    setNewRoomId('');
  };

  const handleJoinExistingRoom = (room: RoomInfo) => {
    if (!userName.trim()) {
      alert('Please enter your name');
      return;
    }
    const videoId = config?.videoCatalog.find(v => v.trackName === room.videoName)?.id || 
                    (config?.videoCatalog[0]?.id || '');
    onJoinRoom(room.id, 'follower', userName.trim(), videoId);
  };

  return (
    <div
      style={{
        padding: '24px',
        backgroundColor: '#f8f9fa',
        borderRadius: '12px',
        border: '2px solid #dee2e6',
        maxWidth: '800px',
        margin: '0 auto',
      }}
    >
      <h2 style={{ marginTop: 0, marginBottom: '20px', color: '#212529' }}>
        SyncPlay Rooms
      </h2>

      <div style={{ marginBottom: '20px' }}>
        <label
          htmlFor="userName"
          style={{
            display: 'block',
            marginBottom: '6px',
            fontWeight: '600',
            color: '#495057',
          }}
        >
          Your Name
        </label>
        <input
          id="userName"
          type="text"
          value={userName}
          onChange={(e) => setUserName(e.target.value)}
          placeholder="Enter your name"
          disabled={disabled}
          style={{
            width: '100%',
            padding: '10px',
            fontSize: '16px',
            border: '1px solid #ced4da',
            borderRadius: '6px',
            boxSizing: 'border-box',
          }}
        />
      </div>

      <div style={{ marginBottom: '20px' }}>
        <h3 style={{ marginBottom: '12px', color: '#212529' }}>Available Rooms</h3>
        {rooms.length === 0 ? (
          <p style={{ color: '#6c757d', fontStyle: 'italic', marginBottom: '16px' }}>
            No active rooms. Create a new room to get started!
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
            {rooms.map((room) => (
              <div
                key={room.id}
                style={{
                  padding: '16px',
                  backgroundColor: 'white',
                  border: '1px solid #dee2e6',
                  borderRadius: '8px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: '600', fontSize: '16px', marginBottom: '4px' }}>
                    {room.id}
                  </div>
                  <div style={{ fontSize: '14px', color: '#6c757d' }}>
                    Video: {room.videoName}
                  </div>
                  <div style={{ fontSize: '14px', color: '#6c757d' }}>
                    Users: {room.userCount} | Leader: {room.leaderName || 'None'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleJoinExistingRoom(room)}
                  disabled={disabled || !room.hasLeader}
                  style={{
                    padding: '8px 16px',
                    fontSize: '14px',
                    fontWeight: '600',
                    color: 'white',
                    backgroundColor: !room.hasLeader ? '#6c757d' : '#28a745',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: !room.hasLeader ? 'not-allowed' : 'pointer',
                  }}
                >
                  {room.hasLeader ? 'Join' : 'No Leader'}
                </button>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowCreateForm(!showCreateForm)}
          style={{
            width: '100%',
            padding: '12px 20px',
            fontSize: '16px',
            fontWeight: '600',
            color: 'white',
            backgroundColor: showCreateForm ? '#6c757d' : '#28a745',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          {showCreateForm ? 'Cancel' : 'Create New Room'}
        </button>
      </div>

      {showCreateForm && (
        <div style={{ 
          padding: '20px', 
          backgroundColor: 'white', 
          border: '2px solid #28a745',
          borderRadius: '8px'
        }}>
          <h3 style={{ marginTop: 0, marginBottom: '16px', color: '#212529' }}>Create New Room</h3>
          
          <div style={{ marginBottom: '16px' }}>
            <label
              htmlFor="newRoomId"
              style={{
                display: 'block',
                marginBottom: '6px',
                fontWeight: '600',
                color: '#495057',
              }}
            >
              Room Name
            </label>
            <input
              id="newRoomId"
              type="text"
              value={newRoomId}
              onChange={(e) => setNewRoomId(e.target.value)}
              placeholder="Enter room name"
              disabled={disabled}
              style={{
                width: '100%',
                padding: '10px',
                fontSize: '16px',
                border: '1px solid #ced4da',
                borderRadius: '6px',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label
              htmlFor="videoSelect"
              style={{
                display: 'block',
                marginBottom: '6px',
                fontWeight: '600',
                color: '#495057',
              }}
            >
              Select Video
            </label>
            <select
              id="videoSelect"
              value={selectedVideo}
              onChange={(e) => setSelectedVideo(e.target.value)}
              disabled={disabled || !config || config.videoCatalog.length === 0}
              style={{
                width: '100%',
                padding: '10px',
                fontSize: '16px',
                border: '1px solid #ced4da',
                borderRadius: '6px',
                boxSizing: 'border-box',
              }}
            >
              {!config || config.videoCatalog.length === 0 ? (
                <option value="">Loading videos...</option>
              ) : (
                config.videoCatalog.map((video) => (
                  <option key={video.id} value={video.id}>
                    {video.name}
                  </option>
                ))
              )}
            </select>
          </div>

          <button
            type="button"
            onClick={handleCreateRoom}
            disabled={disabled}
            style={{
              width: '100%',
              padding: '12px 20px',
              fontSize: '16px',
              fontWeight: '600',
              color: 'white',
              backgroundColor: disabled ? '#6c757d' : '#28a745',
              border: 'none',
              borderRadius: '6px',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            Create Room as Leader
          </button>
        </div>
      )}
    </div>
  );
}
