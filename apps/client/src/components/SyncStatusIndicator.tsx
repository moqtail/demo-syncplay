import { useState, useEffect, useRef } from 'react';
import type { UserRole } from '../types';

interface SyncStatusIndicatorProps {
  role: UserRole;
  roomId: string;
  leaderName: string | null;
  totalUsers: number;
  syncDelta?: number; // For followers - difference from leader in seconds
  isConnected: boolean;
  deltaThreshold?: number; // For followers - threshold in seconds
  onDeltaThresholdChange?: (newThresholdMs: number) => void;
  minDriftMs?: number; // Minimum allowed drift in milliseconds
  maxDriftMs?: number; // Maximum allowed drift in milliseconds
}

export function SyncStatusIndicator({
  role,
  roomId,
  leaderName,
  totalUsers,
  syncDelta,
  isConnected,
  deltaThreshold,
  onDeltaThresholdChange,
  minDriftMs = 200,
  maxDriftMs = 3000,
}: SyncStatusIndicatorProps) {
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  const threshold = deltaThreshold ?? 0.5;

  // Close settings when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        setShowSettings(false);
      }
    };

    if (showSettings) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSettings]);

  const getSyncStatusText = () => {
    if (!isConnected) return '🔴 Disconnected';
    
    if (role === 'leader') {
      return '✓ Broadcasting';
    } else {
      if (syncDelta === undefined) return '⏳ Waiting for sync...';
      if (syncDelta < threshold) return '✓ In Sync';
      return '❌ Out of Sync';
    }
  };

  const getSyncStatusColor = () => {
    if (!isConnected) return '#dc3545';
    
    if (role === 'leader') {
      return '#577B9F';
    } else {
      if (syncDelta === undefined) return '#6c757d';
      if (syncDelta < threshold) return '#28a745';
      return '#dc3545';
    }
  };

  const handleAdjustThreshold = (increment: number) => {
    if (!onDeltaThresholdChange) return;
    const currentMs = threshold * 1000;
    const newMs = Math.max(minDriftMs, Math.min(maxDriftMs, currentMs + increment));
    onDeltaThresholdChange(newMs);
  };

  return (
    <div
      style={{
        padding: '16px',
        backgroundColor: '#ffffff',
        borderRadius: '8px',
        border: '2px solid #dee2e6',
        marginBottom: '16px',
      }}
    >
      <div style={{ marginBottom: '12px' }}>
        <h3 style={{ margin: 0, marginBottom: '8px', fontSize: '18px', color: '#212529' }}>
          🎬 Room: {roomId}
        </h3>
        <div style={{ display: 'flex', gap: '16px', fontSize: '14px', color: '#495057' }}>
          <span>👤 {totalUsers === 1 ? 'User' : 'Users'}: {totalUsers}</span>
          {role === 'leader' ? (
            <span style={{ fontWeight: 'bold', color: '#577B9F' }}>👑 You are the Leader</span>
          ) : (
            <span>
              👑 Leader: {leaderName || 'None'}
            </span>
          )}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 12px',
          backgroundColor: '#f8f9fa',
          borderRadius: '6px',
          borderLeft: `4px solid ${getSyncStatusColor()}`,
          position: 'relative',
        }}
      >
        <span style={{ fontWeight: '600', color: '#212529' }}>Sync Status:</span>
        <span style={{ color: getSyncStatusColor(), fontWeight: '600' }}>
          {getSyncStatusText()}
        </span>
        {role === 'follower' && syncDelta !== undefined && (
          <span style={{ fontSize: '12px', color: '#6c757d', marginLeft: '8px' }}>
            ± {(syncDelta * 1000).toFixed(0)}ms
          </span>
        )}
        {role === 'follower' && (
          <div ref={settingsRef} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
            <button
              onClick={() => setShowSettings(!showSettings)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: '16px',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
                color: '#495057',
              }}
              title="Adjust sync settings"
            >
              ⚙️
            </button>
            {showSettings && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: '0',
                  marginTop: '4px',
                  padding: '10px',
                  backgroundColor: 'white',
                  borderRadius: '6px',
                  border: '1px solid #dee2e6',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                  zIndex: 1000,
                  minWidth: '200px',
                }}
              >
                <div style={{ marginBottom: '6px', fontSize: '11px', fontWeight: '600', color: '#495057' }}>
                  Max Allowed Drift
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    onClick={() => handleAdjustThreshold(-100)}
                    disabled={threshold * 1000 <= minDriftMs}
                    style={{
                      padding: '4px 10px',
                      fontSize: '14px',
                      fontWeight: 'bold',
                      backgroundColor: threshold * 1000 <= minDriftMs ? '#e9ecef' : '#577B9F',
                      color: threshold * 1000 <= minDriftMs ? '#6c757d' : 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: threshold * 1000 <= minDriftMs ? 'not-allowed' : 'pointer',
                    }}
                  >
                    −
                  </button>
                  <span style={{ fontSize: '14px', fontWeight: '600', minWidth: '55px', textAlign: 'center' }}>
                    {(threshold * 1000).toFixed(0)}ms
                  </span>
                  <button
                    onClick={() => handleAdjustThreshold(100)}
                    disabled={threshold * 1000 >= maxDriftMs}
                    style={{
                      padding: '4px 10px',
                      fontSize: '14px',
                      fontWeight: 'bold',
                      backgroundColor: threshold * 1000 >= maxDriftMs ? '#e9ecef' : '#577B9F',
                      color: threshold * 1000 >= maxDriftMs ? '#6c757d' : 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: threshold * 1000 >= maxDriftMs ? 'not-allowed' : 'pointer',
                    }}
                  >
                    +
                  </button>
                </div>
                <div style={{ marginTop: '6px', fontSize: '10px', color: '#6c757d', textAlign: 'center' }}>
                  {minDriftMs}ms - {maxDriftMs}ms
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {role === 'follower' && (
        <div
          style={{
            marginTop: '12px',
            padding: '8px',
            backgroundColor: '#fff3cd',
            border: '1px solid #ffc107',
            borderRadius: '4px',
            fontSize: '12px',
            color: '#856404',
          }}
        >
          ℹ️ Playback is controlled by the leader. Your controls are disabled.
        </div>
      )}
    </div>
  );
}
