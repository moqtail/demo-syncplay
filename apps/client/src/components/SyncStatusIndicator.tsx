import type { UserRole } from '../types';

interface SyncStatusIndicatorProps {
  role: UserRole;
  roomId: string;
  leaderName: string | null;
  totalUsers: number;
  syncDelta?: number; // For followers - difference from leader in seconds
  isConnected: boolean;
}

export function SyncStatusIndicator({
  role,
  roomId,
  leaderName,
  totalUsers,
  syncDelta,
  isConnected,
}: SyncStatusIndicatorProps) {
  const getSyncStatusText = () => {
    if (!isConnected) return '🔴 Disconnected';
    
    if (role === 'leader') {
      return '✓ Broadcasting';
    } else {
      if (syncDelta === undefined) return '⏳ Waiting for sync...';
      if (syncDelta < 0.3) return '✓ In Sync';
      if (syncDelta < 1.0) return '⚠️ Slight Delay';
      return '❌ Out of Sync';
    }
  };

  const getSyncStatusColor = () => {
    if (!isConnected) return '#dc3545';
    
    if (role === 'leader') {
      return '#007bff';
    } else {
      if (syncDelta === undefined) return '#6c757d';
      if (syncDelta < 0.3) return '#28a745';
      if (syncDelta < 1.0) return '#ffc107';
      return '#dc3545';
    }
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
            <span style={{ fontWeight: 'bold', color: '#007bff' }}>👑 You are the Leader</span>
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
        }}
      >
        <span style={{ fontWeight: '600', color: '#212529' }}>Sync Status:</span>
        <span style={{ color: getSyncStatusColor(), fontWeight: '600' }}>
          {getSyncStatusText()}
        </span>
        {role === 'follower' && syncDelta !== undefined && (
          <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#6c757d' }}>
            ± {syncDelta.toFixed(2)}s
          </span>
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
