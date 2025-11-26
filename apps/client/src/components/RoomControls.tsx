import { useState, useEffect } from 'react';
import type { UserRole, RoomInfo, ServerConfig } from '../types';
import '../App.css'

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
    <div className="join-form">
      <h2>SyncPlay Rooms</h2>

      <div className="join-field">
        <label htmlFor="userName" className="join-label">
          Your Name
        </label>
        <input
          id="userName"
          type="text"
          value={userName}
          onChange={(e) => setUserName(e.target.value)}
          placeholder="Enter your name"
          disabled={disabled}
          className="join-input"
        />
      </div>

      <div className="rooms-section">
        <h3 className="rooms-title">Available Rooms</h3>
        {rooms.length === 0 ? (
          <p className="rooms-empty">
            No active rooms. Create a new room to get started!
          </p>
        ) : (
          <div className="room-list">
            {rooms.map((room) => (
              <div key={room.id} className="room-card">
                <div className="room-card-info">
                  <div className="room-card-title">
                    {room.id}
                  </div>
                  <div className="room-card-meta">
                    Video: {room.videoName}
                  </div>
                  <div className="room-card-meta">
                    {room.userCount === 1 ? 'User' : 'Users'}: {room.userCount} | Leader: {room.leaderName || 'None'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleJoinExistingRoom(room)}
                  disabled={disabled || !room.hasLeader}
                  className="join-button"
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
          className={`join-button ${showCreateForm ? 'join-button--secondary' : ''}`}
        >
          {showCreateForm ? 'Cancel' : 'Create New Room'}
        </button>
      </div>

      {showCreateForm && (
        <div className="create-room-card">
          <h3 className="rooms-title">Create New Room</h3>
          
          <div className="join-field">
            <label htmlFor="newRoomId" className="join-label">
              Room Name
            </label>
            <input
              id="newRoomId"
              type="text"
              value={newRoomId}
              onChange={(e) => setNewRoomId(e.target.value)}
              placeholder="Enter room name"
              disabled={disabled}
              className="join-input"
            />
          </div>

          <div className="join-field">
            <label htmlFor="videoSelect" className="join-label">
              Select Video
            </label>
            <select
              id="videoSelect"
              value={selectedVideo}
              onChange={(e) => setSelectedVideo(e.target.value)}
              disabled={disabled || !config || config.videoCatalog.length === 0}
              className="join-input"
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
            className="join-button"
          >
            Create Room as Leader
          </button>
        </div>
      )}
    </div>
  );
}
