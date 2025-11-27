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

import { useEffect, useRef, useCallback, useState } from 'react';
import { SyncPlayService } from '../services/SyncPlayService';
import type {
  UserRole,
  SyncConfig,
  SyncUpdateMessage,
  PlaybackControlMessage,
} from '../types';

interface UseSyncPlaybackProps {
  syncService: SyncPlayService | null;
  role: UserRole | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  syncConfig: SyncConfig;
  timeToGroup: (time: number) => number;
  timeToObject: (time: number) => number;
  onSyncRequired?: (targetTime: number, targetGroup: number) => void;
  isIndependentMode?: boolean;
}

export function useSyncPlayback({
  syncService,
  role,
  videoRef,
  syncConfig,
  timeToGroup,
  timeToObject,
  onSyncRequired,
  isIndependentMode: isDecoupledPlayback = false,
}: UseSyncPlaybackProps) {
  const lastSyncTimeRef = useRef<number>(0);
  const syncDeltaRef = useRef<number>(0);
  const [syncDelta, setSyncDelta] = useState<number>(0);
  const broadcastIntervalRef = useRef<number | null>(null);
  const deltaThresholdRef = useRef<number>(syncConfig.deltaThresholdSeconds);

  // Update the threshold ref whenever syncConfig changes
  useEffect(() => {
    console.log(`[SyncPlayback] Updating deltaThreshold ref to ${syncConfig.deltaThresholdSeconds}s (${syncConfig.deltaThresholdSeconds * 1000}ms)`);
    deltaThresholdRef.current = syncConfig.deltaThresholdSeconds;
  }, [syncConfig.deltaThresholdSeconds]);

  const handleSyncUpdate = useCallback(
    (message: SyncUpdateMessage) => {
      const video = videoRef.current;
      if (!video || isDecoupledPlayback) return;

      const leaderTime = message.timestamp;
      const currentTime = video.currentTime;
      const delta = Math.abs(currentTime - leaderTime);

      syncDeltaRef.current = delta;
      setSyncDelta(delta);
      lastSyncTimeRef.current = Date.now();

      console.log(`[SyncPlayback] Follower sync update: delta=${delta.toFixed(3)}s, threshold=${deltaThresholdRef.current.toFixed(3)}s, needsSync=${delta > deltaThresholdRef.current}`);

      if (onSyncRequired) {
        onSyncRequired(leaderTime, message.groupId);
      }

      if (delta > deltaThresholdRef.current) {
        console.log(
          `[SyncPlayback] Follower: OUT OF SYNC (Δ ${delta.toFixed(2)}s, threshold ${deltaThresholdRef.current.toFixed(2)}s) - seeking to ${leaderTime.toFixed(2)}s`
        );
        
        video.currentTime = leaderTime;
      }

      if (message.isPlaying && video.paused) {
        console.log('[SyncPlayback] Follower: Starting playback');
        video.play().catch((error) => {
          console.error('[SyncPlayback] Error starting playback:', error);
        });
      } else if (!message.isPlaying && !video.paused) {
        console.log('[SyncPlayback] Follower: Pausing playback');
        video.pause();
      }
    },
    [videoRef, onSyncRequired, isDecoupledPlayback]
  );

  const handlePlaybackControl = useCallback(
    (message: PlaybackControlMessage) => {
      const video = videoRef.current;
      if (!video || isDecoupledPlayback) return;

      console.log(`[SyncPlayback] Follower: Playback control - ${message.action}`);

      switch (message.action) {
        case 'play':
          if (video.paused) {
            video.play().catch((error) => {
              console.error('[SyncPlayback] Error starting playback:', error);
            });
          }
          break;

        case 'pause':
          if (!video.paused) {
            video.pause();
          }
          break;

        case 'seek':
          if (message.seekTarget !== undefined) {
            console.log(`[SyncPlayback] Follower: Seeking to ${message.seekTarget.toFixed(2)}s`);
            video.currentTime = message.seekTarget;
            
            if (onSyncRequired) {
              onSyncRequired(message.seekTarget, message.groupId);
            }
          }
          break;
      }
    },
    [videoRef, onSyncRequired, isDecoupledPlayback]
  );

  useEffect(() => {
    console.log(`[SyncPlayback] Leader broadcast effect - syncService: ${!!syncService}, role: ${role}, video: ${!!videoRef.current}`);
    
    if (!syncService || role !== 'leader') return;

    const broadcastPosition = () => {
      const video = videoRef.current;
      
      if (!video || !syncService.isConnected()) {
        return; 
      }

      const currentTime = video.currentTime;
      const groupId = timeToGroup(currentTime);
      const objectId = timeToObject(currentTime);
      const isPlaying = !video.paused;

      console.log(`[SyncPlayback] Leader: Broadcasting position t=${currentTime.toFixed(2)}s, g=${groupId}, playing=${isPlaying}`);
      syncService.sendSyncUpdate(currentTime, groupId, objectId, isPlaying);
    };

    broadcastIntervalRef.current = window.setInterval(
      broadcastPosition,
      syncConfig.leaderBroadcastIntervalMs
    );

    console.log(`[SyncPlayback] Leader started broadcasting every ${syncConfig.leaderBroadcastIntervalMs}ms`);

    return () => {
      if (broadcastIntervalRef.current !== null) {
        clearInterval(broadcastIntervalRef.current);
        broadcastIntervalRef.current = null;
        console.log('[SyncPlayback] Leader stopped broadcasting');
      }
    };
  }, [syncService, role, videoRef, syncConfig, timeToGroup, timeToObject]);

  useEffect(() => {
    if (!syncService || role !== 'leader' || !videoRef.current) return;

    const video = videoRef.current;

    const handlePlay = () => {
      if (!syncService.isConnected()) return;
      const currentTime = video.currentTime;
      const groupId = timeToGroup(currentTime);
      const objectId = timeToObject(currentTime);
      
      console.log('[SyncPlayback] Leader: PLAY');
      syncService.sendPlaybackControl('play', currentTime, groupId, objectId);
    };

    const handlePause = () => {
      if (!syncService.isConnected()) return;
      const currentTime = video.currentTime;
      const groupId = timeToGroup(currentTime);
      const objectId = timeToObject(currentTime);
      
      console.log('[SyncPlayback] Leader: PAUSE');
      syncService.sendPlaybackControl('pause', currentTime, groupId, objectId);
    };

    const handleSeeking = () => {
      if (!syncService.isConnected()) return;
      const currentTime = video.currentTime;
      const groupId = timeToGroup(currentTime);
      const objectId = timeToObject(currentTime);
      
      console.log(`[SyncPlayback] Leader: SEEK to ${currentTime.toFixed(2)}s`);
      syncService.sendPlaybackControl('seek', currentTime, groupId, objectId, currentTime);
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('seeking', handleSeeking);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('seeking', handleSeeking);
    };
  }, [syncService, role, videoRef, timeToGroup, timeToObject]);

  useEffect(() => {
    if (!syncService || role !== 'follower') return;

    const handleMessage = (message: SyncUpdateMessage | PlaybackControlMessage) => {
      if (message.type === 'sync-update') {
        handleSyncUpdate(message);
      } else if (message.type === 'playback-control') {
        handlePlaybackControl(message);
      }
    };

    const unsubscribe = syncService.onMessage((msg) => {
      if (msg.type === 'sync-update' || msg.type === 'playback-control') {
        handleMessage(msg as SyncUpdateMessage | PlaybackControlMessage);
      }
    });

    return unsubscribe;
  }, [syncService, role, handleSyncUpdate, handlePlaybackControl]);

  return {
    syncDelta,
  };
}
