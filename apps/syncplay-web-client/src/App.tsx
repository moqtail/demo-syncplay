import { useEffect, useState, useRef, useCallback } from 'react'
import type { RequestState, UserRole, SyncConfig, RoomStateMessage, RoomInfo, ServerConfig, ErrorMessage } from './types'
import { 
  disconnectMOQ, 
  subscribeToDemo, 
  requestInitWithMOQ, 
  requestFragmentRangeBodyWithMOQ ,
  fetchRangeStreamingWithMOQ,
} from './moq-api'
import { SyncPlayService } from './services/SyncPlayService'
import { useSyncPlayback } from './hooks/useSyncPlayback'
import { RoomControls } from './components/RoomControls'
import { SyncStatusIndicator } from './components/SyncStatusIndicator'
import './MP4Requester.css'

const MSE_MIME = 'video/mp4; codecs="avc1.64001F, mp4a.40.2"'

// TODO: AppSettings should be moved to public appsettings
interface AppSettings {
  groupsPerSecond: number       
  objectsPerGroup: number       
  fetchAheadSeconds: number     // Ahead buffer size in seconds
  backBufferSeconds: number     // Recently played buffer size in seconds
  maxBufferSeconds: number      // Total buffer size in seconds
  fetchThrottleMs: number       // Delay between fetch requests
}

const DEFAULT_SETTINGS: AppSettings = {
  groupsPerSecond: 1,
  objectsPerGroup: 48,   // 24 video + 24 audio
  fetchAheadSeconds: 5, // ahead buffer
  backBufferSeconds: 5,  // keep 5s behind playhead
  maxBufferSeconds: 20,  // total budget (>= back + ahead recommended)
  fetchThrottleMs: 50,
}

const DEFAULT_SYNC_CONFIG: SyncConfig = {
  deltaThresholdSeconds: 0.5,
  leaderBroadcastIntervalMs: 50,
  wsUrl: 'ws://localhost:8080',
  wsReconnectDelayMs: 3000,
}

function App() {
  const [settings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [syncConfig] = useState<SyncConfig>(DEFAULT_SYNC_CONFIG)
  
  const [requestState, setRequestState] = useState<RequestState>({
    isLoading: false,
    error: null,
  })
  
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  const [hasJoinedRoom, setHasJoinedRoom] = useState(false)
  const [relaySubscribed, setRelaySubscribed] = useState(false)
  
  // Routing state
  const [currentPage, setCurrentPage] = useState<'lobby' | 'room'>('lobby')
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null)

  const [rooms, setRooms] = useState<RoomInfo[]>([])
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null)

  const [syncService, setSyncService] = useState<SyncPlayService | null>(null)
  const [userRole, setUserRole] = useState<UserRole | null>(null)
  const [roomState, setRoomState] = useState<RoomStateMessage | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const initialPlaybackStateRef = useRef<{ timestamp: number; isPlaying: boolean } | null>(null)

  // Playback info display
  const [currentTime, setCurrentTime] = useState(0)
  const [currentGroup, setCurrentGroup] = useState(0)
  const [currentObject, setCurrentObject] = useState(0)

  // MSE-related refs
  const mediaSourceRef = useRef<MediaSource | null>(null)
  const sourceBufferRef = useRef<SourceBuffer | null>(null)
  const appendQueueRef = useRef<Uint8Array[]>([])
  const appendingRef = useRef(false)
  const streamingRef = useRef(false)
  const nextGroupRef = useRef<number>(1)
  
  // Buffer management
  const bufferedRangesRef = useRef<Set<number>>(new Set()) // Track which groups are buffered
  const isSeeking = useRef(false)
  const hasJumpedAheadRef = useRef(false) // Track if follower has jumped to leader's position
  
  // For followers: track leader's position
  const leaderPositionRef = useRef<{ time: number; group: number } | null>(null)

  // ============ UTILITY FUNCTIONS ============
  
  // Sync URL with state
  useEffect(() => {
    const path = window.location.pathname
    if (path === '/' || path === '') {
      setCurrentPage('lobby')
      setCurrentRoomId(null)
    } else {
      const roomId = path.substring(1) // Remove leading /
      if (roomId) {
        setCurrentPage('room')
        setCurrentRoomId(roomId)
      }
    }
  }, [])

  // Update URL when page changes
  useEffect(() => {
    if (currentPage === 'lobby') {
      window.history.pushState({}, '', '/')
    } else if (currentPage === 'room' && currentRoomId) {
      window.history.pushState({}, '', `/${currentRoomId}`)
    }
  }, [currentPage, currentRoomId])

  // Handle browser back/forward
  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname
      if (path === '/' || path === '') {
        setCurrentPage('lobby')
        setCurrentRoomId(null)
        setHasJoinedRoom(false)
      } else {
        const roomId = path.substring(1)
        if (roomId) {
          setCurrentPage('room')
          setCurrentRoomId(roomId)
        }
      }
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])
  
  const timeToGroup = useCallback((timeSeconds: number): number => {
    return Math.floor(timeSeconds * settings.groupsPerSecond)
  }, [settings.groupsPerSecond])

  const timeToObject = useCallback((timeSeconds: number): number => {
    const fractionalSecond = timeSeconds % 1
    return Math.floor(fractionalSecond * settings.objectsPerGroup)
  }, [settings.objectsPerGroup])

  const isRangeBuffered = useCallback((startGroup: number, endGroup: number): boolean => {
    for (let g = startGroup; g <= endGroup; g++) {
      if (!bufferedRangesRef.current.has(g)) {
        return false
      }
    }
    return true
  }, [])

  const markGroupsBuffered = useCallback((startGroup: number, endGroup: number) => {
    for (let g = startGroup; g <= endGroup; g++) {
      bufferedRangesRef.current.add(g)
    }
  }, [])

  const enqueueAppend = useCallback((data: Uint8Array) => {
    const sb = sourceBufferRef.current
    if (!sb) {
      console.warn('SourceBuffer not ready yet, dropping data')
      return
    }

    appendQueueRef.current.push(data)
    // avoid circular dependency
    const maybeAppend = () => {
      if (!sb || appendingRef.current || sb.updating) return
      const next = appendQueueRef.current.shift()
      if (!next) return

      appendingRef.current = true
      try {
        const copy = new Uint8Array(next)
        sb.appendBuffer(copy)
      } catch (e) {
        console.error('appendBuffer error', e)
        appendingRef.current = false
      }
    }
    maybeAppend()
  }, [])

  const maybeAppendNext = useCallback(() => {
    const sb = sourceBufferRef.current
    if (!sb) return
    if (appendingRef.current) return
    if (sb.updating) return

    const next = appendQueueRef.current.shift()
    if (!next) return

    appendingRef.current = true
    try {
      // Create a copy to ensure it's an ArrayBuffer
      const copy = new Uint8Array(next)
      sb.appendBuffer(copy)
    } catch (e) {
      console.error('appendBuffer error', e)
      appendingRef.current = false
    }
  }, [])

  const cleanupBuffer = useCallback((currentTimeSeconds: number) => {
    const sb = sourceBufferRef.current
    if (!sb || sb.updating) return

    try {
      const buffered = sb.buffered
      if (buffered.length === 0) return

      const t = currentTimeSeconds
      const back = settings.backBufferSeconds
      const ahead = settings.fetchAheadSeconds
      const totalBudget = settings.maxBufferSeconds

      const mainStart = Math.max(0, t - back)
      const mainEnd = t + ahead

      const ranges: { start: number; end: number }[] = []
      let totalDuration = 0
      for (let i = 0; i < buffered.length; i++) {
        const start = buffered.start(i)
        const end = buffered.end(i)
        if (end <= start) continue
        ranges.push({ start, end })
        totalDuration += (end - start)
      }

      if (ranges.length === 0) return

      if (totalDuration <= totalBudget) return

      let removeStart: number | null = null
      let removeEnd: number | null = null

      const first = ranges[0]
      const last = ranges[ranges.length - 1]

      if (first.end <= mainStart) {
        removeStart = first.start
        removeEnd = first.end
        console.log(
          `cleanupBuffer: removing fully old range [${removeStart.toFixed(2)}, ${removeEnd.toFixed(2)}], mainStart=${mainStart.toFixed(2)}`
        )
      }
      
      else if (last.start >= mainEnd) {
        removeStart = last.start
        removeEnd = last.end
        console.log(
          `cleanupBuffer: removing fully future range [${removeStart.toFixed(2)}, ${removeEnd.toFixed(2)}], mainEnd=${mainEnd.toFixed(2)}`
        )
      }
      else {
        if (first.start < mainStart && first.end > mainStart) {
          removeStart = first.start
          removeEnd = mainStart
          console.log(
            `cleanupBuffer: trimming old tail [${removeStart.toFixed(2)}, ${removeEnd.toFixed(2)}] from [${first.start.toFixed(2)}, ${first.end.toFixed(2)}]`
          )
        } else if (last.start < mainEnd && last.end > mainEnd) {
          removeStart = mainEnd
          removeEnd = last.end
          console.log(
            `cleanupBuffer: trimming future head [${removeStart.toFixed(2)}, ${removeEnd.toFixed(2)}] from [${last.start.toFixed(2)}, ${last.end.toFixed(2)}]`
          )
        } else {
          const cutoff = Math.max(0, t - back)
          removeStart = first.start
          removeEnd = Math.min(first.end, cutoff)
          if (removeEnd > removeStart) {
            console.warn(
              `cleanupBuffer: fallback trimming [${removeStart.toFixed(2)}, ${removeEnd.toFixed(2)}] due to tight budget`
            )
          } else {
            removeStart = null
            removeEnd = null
          }
        }
      }

      if (removeStart != null && removeEnd != null && removeEnd > removeStart) {
        try {
          sb.remove(removeStart, removeEnd)
          const startGroup = timeToGroup(removeStart)
          const endGroup = timeToGroup(removeEnd)
          for (let g = startGroup; g <= endGroup; g++) {
            bufferedRangesRef.current.delete(g)
          }
        } catch (e) {
          console.error('cleanupBuffer: sb.remove failed', e)
        }
      }
    } catch (e) {
      console.error('Error in cleanupBuffer:', e)
    }
  }, [
    settings.backBufferSeconds,
    settings.fetchAheadSeconds,
    settings.maxBufferSeconds,
    timeToGroup,
  ])

  // ============ SYNC PLAYBACK INTEGRATION ============

  const handleSyncRequired = useCallback(async (targetTime: number, targetGroup: number) => {
    console.log(`[App] Sync required: fetching group ${targetGroup} for time ${targetTime.toFixed(2)}s`)
    
    // Update leader position ref for followers
    if (userRole === 'follower') {
      leaderPositionRef.current = { time: targetTime, group: targetGroup }
    }
    
    const fetchAheadGroups = settings.fetchAheadSeconds * settings.groupsPerSecond
    const endGroup = targetGroup + fetchAheadGroups - 1

    for (let g = targetGroup; g <= Math.min(targetGroup + 10, endGroup); g++) {
      if (!bufferedRangesRef.current.has(g)) {
        try {
          const fragmentData = await requestFragmentRangeBodyWithMOQ({
            startGroupId: g,
            startObjectId: 0,
            endGroupId: g,
            endObjectId: 0,
          })
          enqueueAppend(fragmentData)
          markGroupsBuffered(g, g)
        } catch (err) {
          console.error(`Error fetching group ${g}:`, err)
        }
      }
    }

    nextGroupRef.current = Math.max(nextGroupRef.current, targetGroup + fetchAheadGroups)
  }, [settings.fetchAheadSeconds, settings.groupsPerSecond, enqueueAppend, markGroupsBuffered, userRole])

  const { syncDelta } = useSyncPlayback({
    syncService,
    role: userRole,
    videoRef,
    syncConfig,
    timeToGroup,
    timeToObject,
    onSyncRequired: handleSyncRequired,
  })

  // ============ SYNC & ROOM MANAGEMENT ============

  // Initialize sync service
  useEffect(() => {
    const service = new SyncPlayService(syncConfig)
    setSyncService(service)

    service.connect().then(() => {
      console.log('[App] Connected to sync server, requesting config and rooms')
      service.requestConfig()
      service.requestRoomsList()
    }).catch((error) => {
      console.error('[App] Failed to connect to sync server:', error)
    })

    service.onRoomState((state) => {
      console.log('[App] Room state received:', state)
      setRoomState(state)
      setUserRole(state.role)
      setIsConnected(true)

      if (state.role === 'follower' && state.currentPlaybackState) {
        console.log(`[App] Follower joining: saving initial playback state ${state.currentPlaybackState.timestamp.toFixed(2)}s`)
        initialPlaybackStateRef.current = {
          timestamp: state.currentPlaybackState.timestamp,
          isPlaying: state.currentPlaybackState.isPlaying,
        }
      }
    })

    service.onMessage((message) => {
      if (message.type === 'user-joined') {
        setRoomState((currentState) => {
          if (currentState) {
            console.log('[App] User joined:', message.userName)
            return {
              ...currentState,
              totalUsers: message.totalUsers,
            }
          }
          return currentState
        })
      } else if (message.type === 'user-left') {
        setRoomState((currentState) => {
          if (currentState) {
            console.log('[App] User left:', message.userName)
            const updatedState = {
              ...currentState,
              totalUsers: message.totalUsers,
            }
            
            if (message.newLeaderId) {
              if (message.newLeaderId === currentState.userId) {
                console.log('[App] Promoted to leader')
                setUserRole('leader')
                updatedState.role = 'leader'
              }
              updatedState.leaderId = message.newLeaderId
            }
            
            return updatedState
          }
          return currentState
        })
      }
    })

    service.onError((error) => {
      console.error('[App] Sync error:', error)
      alert(`Sync Error: ${error.message}`)
      setRequestState({ isLoading: false, error: error.message })
      setHasJoinedRoom(false)
    })

    service.onRoomsList((response) => {
      console.log('[App] Rooms list received:', response.rooms)
      setRooms(response.rooms)
    })

    service.onConfig((response) => {
      console.log('[App] Server config received:', response.config)
      setServerConfig(response.config)
    })

    return () => {
      service.disconnect()
    }
  }, [syncConfig])

  // Handle relay subscription
  const handleSubscribeClick = async () => {
    try {
      setRequestState({ isLoading: true, error: null })
      await subscribeToDemo()
      setRelaySubscribed(true)
      setRequestState({ isLoading: false, error: null })
    } catch (err) {
      console.error('Subscribe failed', err)
      setRequestState({
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleRequestRooms = useCallback(() => {
    if (syncService && syncService.isConnected()) {
      syncService.requestRoomsList()
    }
  }, [syncService])

  const handleRequestConfig = useCallback(() => {
    if (syncService && syncService.isConnected()) {
      syncService.requestConfig()
    }
  }, [syncService])

  const handleJoinRoom = useCallback(async (roomId: string, role: UserRole, userName: string, videoId: string) => {
    if (!syncService || !serverConfig) {
      alert('Sync service not ready, please wait...')
      return
    }

    try {
      setRequestState({ isLoading: true, error: null })

      const video = serverConfig.videoCatalog.find(v => v.id === videoId)
      const trackName = video?.trackName || 'moqtail/demo'

      let joinSuccessful = false
      let joinError: string | null = null

      const handleRoomStateOnce = (state: RoomStateMessage) => {
        if (state.roomId === roomId) {
          joinSuccessful = true
          setUserRole(state.role)
        }
      }

      const handleErrorOnce = (error: ErrorMessage) => {
        joinError = error.message
      }

      const unsubRoomState = syncService.onRoomState(handleRoomStateOnce)
      const unsubError = syncService.onError(handleErrorOnce)

      syncService.joinRoom(roomId, role, userName, trackName)
      
      await new Promise(resolve => setTimeout(resolve, 800))

      unsubRoomState()
      unsubError()

      if (joinError) {
        setRequestState({ isLoading: false, error: joinError })
        return
      }

      if (!joinSuccessful) {
        setRequestState({ isLoading: false, error: 'Failed to join room' })
        return
      }
      
      // Navigate to room page
      setCurrentRoomId(roomId)
      setCurrentPage('room')
      
      if (!relaySubscribed) {
        await subscribeToDemo()
        setRelaySubscribed(true)
      }
      
      await handleJoinRoomClick()

    } catch (err) {
      console.error('Join room failed', err)
      setRequestState({
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
      })
      setHasJoinedRoom(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncService, relaySubscribed, serverConfig])

  const handleLeaveRoom = useCallback(() => {
    console.log('[App] Leaving room...')
    
    // Stop streaming first
    streamingRef.current = false
    
    // Clean up video resources
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl)
      setVideoUrl(null)
    }
    if (mediaSourceRef.current && mediaSourceRef.current.readyState === 'open') {
      try {
        mediaSourceRef.current.endOfStream()
      } catch (e) {
        console.warn('Failed to end MediaSource:', e)
      }
    }
    
    // Reset refs and state
    mediaSourceRef.current = null
    sourceBufferRef.current = null
    hasJumpedAheadRef.current = false
    setHasJoinedRoom(false)
    setUserRole(null)
    setRoomState(null)
    
    // Disconnect and reconnect to properly leave the room on the server
    // disconnect() will close the WebSocket, which triggers the server's disconnect handler
    // This removes the user from the room and broadcasts the update
    if (syncService) {
      syncService.disconnect()
      // Reconnect after a short delay
      setTimeout(() => {
        syncService.connect().then(() => {
          console.log('[App] Reconnected after leaving room')
          handleRequestConfig()
          handleRequestRooms()
        }).catch(err => {
          console.error('[App] Failed to reconnect:', err)
        })
      }, 100)
    }
    
    // Navigate back to lobby
    setCurrentPage('lobby')
    setCurrentRoomId(null)
  }, [videoUrl, syncService, handleRequestConfig, handleRequestRooms])

  const handleJoinRoomClick = async () => {
    try {
      setRequestState({ isLoading: true, error: null })
      setHasJoinedRoom(true)
      streamingRef.current = true
      
      nextGroupRef.current = 1

      const ms = new MediaSource()
      mediaSourceRef.current = ms
      const url = URL.createObjectURL(ms)

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('MediaSource initialization timeout'))
        }, 10000)

        ms.addEventListener('sourceopen', async () => {
          try {
            clearTimeout(timeout)
            console.log('MediaSource opened, adding SourceBuffer:', MSE_MIME)
            const sb = ms.addSourceBuffer(MSE_MIME)
            sourceBufferRef.current = sb

            sb.addEventListener('updateend', () => {
              appendingRef.current = false
              maybeAppendNext()
            })

            console.log('Fetching init via MOQ')
            const initData = await requestInitWithMOQ()
            enqueueAppend(initData)
            bufferedRangesRef.current.add(0)

            setRequestState(prev => ({ ...prev, isLoading: false }))

            resolve()

            // Start the streaming loop in the background
            ;(async () => {
              try {
                while (streamingRef.current) {
                  const video = videoRef.current
                  
                  // For followers, use leader's position; for leader, use own position
                  let currentTimeSeconds: number
                  let currentGroup: number
                  
                  if (userRole === 'follower' && leaderPositionRef.current) {
                    // Follower: use leader's position for fetching
                    currentTimeSeconds = leaderPositionRef.current.time
                    currentGroup = leaderPositionRef.current.group
                    console.log(`[Follower] Using leader position: t=${currentTimeSeconds.toFixed(2)}s, g=${currentGroup}`)
                  } else {
                    // Leader or follower without sync yet: use own position
                    currentTimeSeconds = video?.currentTime || 0
                    currentGroup = timeToGroup(currentTimeSeconds)
                  }
                  
                  const fetchAheadGroups = settings.fetchAheadSeconds * settings.groupsPerSecond
                  const maxGroupToFetch = currentGroup + fetchAheadGroups

                  // For followers: on first join, jump to leader's position to fetch relevant data immediately
                  // This works for BOTH paused and playing video
                  if (userRole === 'follower' && leaderPositionRef.current && !hasJumpedAheadRef.current && currentGroup > 1) {
                    // Keep a small buffer (2 seconds) before the current position for smooth playback
                    const backBuffer = 2
                    const jumpToGroup = Math.max(1, currentGroup - backBuffer)
                    console.log(`[Follower] Initial jump to leader position: nextGroup ${nextGroupRef.current} → ${jumpToGroup} (leader at group ${currentGroup})`)
                    nextGroupRef.current = jumpToGroup
                    hasJumpedAheadRef.current = true
                  }

                  if (nextGroupRef.current <= maxGroupToFetch) {
                    const targetGroup = nextGroupRef.current

                    if (!isRangeBuffered(targetGroup, targetGroup)) {
                      console.log(
                        `Fetching group ${targetGroup} via MOQ (t=${currentTimeSeconds.toFixed(2)}s, g_cur=${currentGroup}, g_max=${maxGroupToFetch})`
                      );

                      await fetchRangeStreamingWithMOQ(
                        targetGroup,
                        0,
                        targetGroup,
                        0,
                        (payload) => {
                          enqueueAppend(payload);
                        },
                      );

                      markGroupsBuffered(targetGroup, targetGroup);
                      nextGroupRef.current = targetGroup + 1;
                    } else {
                      nextGroupRef.current++;
                    }
                  } else {
                    // Fetch is filled, just wait
                  }

                  cleanupBuffer(currentTimeSeconds)
                  // throttle
                  await new Promise(r => setTimeout(r, settings.fetchThrottleMs))
                }
              } catch (err) {
                console.error('Streaming loop failed', err)
                setRequestState({
                  isLoading: false,
                  error: err instanceof Error ? err.message : String(err),
                })
                streamingRef.current = false
                try {
                  ms.endOfStream('network')
                } catch (e) {
                  console.error('Failed to end stream:', e)
                }
              }
            })()
          } catch (e) {
            reject(e)
            console.error('Error in sourceopen handler', e)
            setRequestState({
              isLoading: false,
              error: e instanceof Error ? e.message : String(e),
            })
            streamingRef.current = false
            try {
              ms.endOfStream('network')
            } catch (endErr) {
              console.error('Failed to end stream:', endErr)
            }
          }
        })

        // Set the video URL after registering the sourceopen listener
        // This triggers the sourceopen event
        setVideoUrl(url)
      })
    } catch (err) {
      console.error('Join room failed', err)
      setRequestState({ 
        isLoading: false, 
        error: err instanceof Error ? err.message : String(err) 
      })
    }
  }

  // ============ VIDEO EVENT HANDLERS ============
  
  const handleSeeking = useCallback(async () => {
    const video = videoRef.current
    if (!video || isSeeking.current) return

    const seekTime = video.currentTime
    const seekGroup = timeToGroup(seekTime)
    const fetchAheadGroups = settings.fetchAheadSeconds * settings.groupsPerSecond
    const endGroup = seekGroup + fetchAheadGroups - 1

    console.log(`Seeking to ${seekTime.toFixed(2)}s (group ${seekGroup})`)
    
    if (!isRangeBuffered(seekGroup, Math.min(seekGroup + 5, endGroup))) {
      isSeeking.current = true
      setRequestState({ isLoading: true, error: null })

      try {
        for (let g = seekGroup; g <= Math.min(seekGroup + fetchAheadGroups - 1, seekGroup + 20); g++) {
          if (!bufferedRangesRef.current.has(g)) {
            console.log(`Fetching group ${g} for seek`)
            const fragmentData = await requestFragmentRangeBodyWithMOQ({
              startGroupId: g,
              startObjectId: 0,
              endGroupId: g,
              endObjectId: 0,
            })
            enqueueAppend(fragmentData)
            markGroupsBuffered(g, g)
          }
        }

        nextGroupRef.current = seekGroup + fetchAheadGroups
        setRequestState({ isLoading: false, error: null })
      } catch (err) {
        console.error('Seek fetch failed:', err)
        setRequestState({
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        isSeeking.current = false
      }
    } else {
      console.log(`Seek target already buffered`)
      nextGroupRef.current = Math.max(nextGroupRef.current, seekGroup + fetchAheadGroups)
    }
  }, [settings, timeToGroup, isRangeBuffered, enqueueAppend, markGroupsBuffered])

  // Update playback info display
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current
    if (!video) return

    const time = video.currentTime
    const group = timeToGroup(time)
    const object = timeToObject(time)

    setCurrentTime(time)
    setCurrentGroup(group)
    setCurrentObject(object)
  }, [timeToGroup, timeToObject])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    console.log('Attaching video event listeners')
    video.addEventListener('seeking', handleSeeking)
    video.addEventListener('timeupdate', handleTimeUpdate)

    return () => {
      console.log('Removing video event listeners')
      video.removeEventListener('seeking', handleSeeking)
      video.removeEventListener('timeupdate', handleTimeUpdate)
    }
  }, [handleSeeking, handleTimeUpdate, videoUrl])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoUrl || userRole !== 'follower' || !initialPlaybackStateRef.current) return

    const applyInitialState = () => {
      const initialState = initialPlaybackStateRef.current
      if (!initialState) return

      console.log(`[App] Applying initial playback state for follower: ${initialState.timestamp.toFixed(2)}s, playing: ${initialState.isPlaying}`)
      
      video.currentTime = initialState.timestamp
      
      if (initialState.isPlaying) {
        // For playing video, wait for enough data to be buffered before playing
        const tryPlay = () => {
          if (video.readyState >= 3) { // HAVE_FUTURE_DATA or better
            console.log('[App] Enough data buffered, starting playback')
            video.play().catch((error) => {
              console.error('[App] Error starting playback:', error)
            })
          } else {
            console.log('[App] Waiting for more data before playing...')
            video.addEventListener('canplay', () => {
              console.log('[App] Can play event fired, starting playback')
              video.play().catch((error) => {
                console.error('[App] Error starting playback:', error)
              })
            }, { once: true })
          }
        }
        tryPlay()
      } else {
        // If the video should be paused, we still need to load the frame
        // The seek will happen automatically when currentTime is set
        console.log('[App] Video is paused, frame will load on seek')
      }

      initialPlaybackStateRef.current = null
    }

    if (video.readyState >= 2) {
      applyInitialState()
    } else {
      video.addEventListener('loadeddata', applyInitialState, { once: true })
      return () => {
        video.removeEventListener('loadeddata', applyInitialState)
      }
    }
  }, [videoUrl, userRole])

  useEffect(() => {
    return () => {
      streamingRef.current = false
      if (mediaSourceRef.current && mediaSourceRef.current.readyState === 'open') {
        try {
          mediaSourceRef.current.endOfStream()
        } catch (e) {
          console.error('Failed to end stream on cleanup:', e)
        }
      }
      disconnectMOQ().catch(console.error)
    }
  }, [])

  return (
    <div className="mp4-requester-container">
      <div className="mp4-requester-content">
        {currentPage === 'lobby' ? (
          <>
            <h1 style={{ textAlign: 'center', marginBottom: '30px' }}>SyncPlay - Room Lobby</h1>
            
            {/* Optional Subscribe Button */}
            <div style={{ 
              padding: '16px',
              backgroundColor: '#f8f9fa',
              borderRadius: '8px',
              border: '1px solid #dee2e6',
              maxWidth: '500px',
              margin: '0 auto 20px',
              textAlign: 'center'
            }}>
              <button
                type="button"
                onClick={handleSubscribeClick}
                disabled={requestState.isLoading || relaySubscribed}
                className="mp4-requester-button"
                style={{
                  backgroundColor: relaySubscribed ? '#28a745' : '#007bff',
                  cursor: relaySubscribed ? 'default' : 'pointer',
                  opacity: relaySubscribed ? 0.7 : 1
                }}
              >
                {relaySubscribed ? '✓ Subscribed to Relay' : 'Subscribe to Relay (Optional)'}
              </button>
              <p style={{ fontSize: '0.85em', color: '#6c757d', marginTop: '8px', marginBottom: 0 }}>
                {relaySubscribed 
                  ? 'Relay connection established'
                  : 'Subscribe manually if needed (auto-subscribes on join)'}
              </p>
            </div>

            <RoomControls 
              onJoinRoom={handleJoinRoom}
              onRequestRooms={handleRequestRooms}
              onRequestConfig={handleRequestConfig}
              rooms={rooms}
              config={serverConfig}
              disabled={requestState.isLoading || !syncService}
            />
          </>
        ) : (
          <>

            {/* Sync Status Display */}
            {roomState && (
              <SyncStatusIndicator
                role={userRole!}
                roomId={roomState.roomId}
                leaderName={roomState.leaderName}
                totalUsers={roomState.totalUsers}
                syncDelta={userRole === 'follower' ? syncDelta : undefined}
                isConnected={isConnected}
              />
            )}

            {/* Playback Info Display */}
            <div style={{
              marginTop: '16px',
              padding: '15px',
              backgroundColor: '#e8f4f8',
              borderRadius: '8px',
              border: '1px solid #b3d9e6',
              fontFamily: 'monospace'
            }}>
              <h4 style={{ marginTop: 0, marginBottom: '10px' }}>Playback Info</h4>
              <div style={{ display: 'grid', gap: '8px' }}>
                <div>
                  <strong>Current Time:</strong> {currentTime.toFixed(3)}s
                </div>
                <div>
                  <strong>Current Group:</strong> {currentGroup}
                </div>
                <div>
                  <strong>Current Object:</strong> {currentObject}
                </div>
                <div>
                  <strong>Buffered Groups:</strong> {bufferedRangesRef.current.size}
                </div>
                <div style={{ fontSize: '0.9em', color: '#666', marginTop: '8px' }}>
                  Formula: Time {currentTime.toFixed(2)}s → Group {currentGroup} (= ⌊{currentTime.toFixed(2)} × {settings.groupsPerSecond}⌋)
                </div>
              </div>
            </div>
          </>
        )}

        {requestState.error && (
          <div className="mp4-requester-error">
            Error: {requestState.error}
          </div>
        )}

        {requestState.isLoading && (
          <div style={{ marginTop: '20px', textAlign: 'center' }}>
            Loading video...
          </div>
        )}

        {videoUrl && (
          <div className="mp4-requester-video-container">
            <video
              ref={videoRef}
              controls={userRole === 'leader'} // Only leader has controls
              className="mp4-requester-video"
              src={videoUrl}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default App