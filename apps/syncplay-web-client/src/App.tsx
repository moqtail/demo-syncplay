import { useEffect, useState, useRef, useCallback } from 'react'
import type { RequestState } from './types'
import { 
  disconnectMOQ, 
  subscribeToDemo, 
  requestInitWithMOQ, 
  requestFragmentRangeBodyWithMOQ ,
  fetchRangeStreamingWithMOQ,
} from './moq-api'
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

function App() {
  const [settings] = useState<AppSettings>(DEFAULT_SETTINGS)
  
  const [requestState, setRequestState] = useState<RequestState>({
    isLoading: false,
    error: null,
  })
  
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  const [showJoinRoom, setShowJoinRoom] = useState(false)
  const [hasJoinedRoom, setHasJoinedRoom] = useState(false)

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

  // ============ UTILITY FUNCTIONS ============
  
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

  //TODO: To be removed when relay can actually forward fetch
  const handleSubscribeClick = async () => {
    try {
      await subscribeToDemo()
      setTimeout(() => {
        setShowJoinRoom(true)
      }, 15000)
    } catch (err) {
      console.error('Subscribe failed', err)
      alert('Subscribe failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const handleJoinRoomClick = async () => {
    try {
      setRequestState({ isLoading: true, error: null })
      setHasJoinedRoom(true)
      streamingRef.current = true
      nextGroupRef.current = 1

      const ms = new MediaSource()
      mediaSourceRef.current = ms
      const url = URL.createObjectURL(ms)
      setVideoUrl(url)

      ms.addEventListener('sourceopen', async () => {
        try {
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

          ;(async () => {
            try {
              while (streamingRef.current) {
                const video = videoRef.current
                const currentTimeSeconds = video?.currentTime || 0
                
                const currentGroup = timeToGroup(currentTimeSeconds)
                const fetchAheadGroups = settings.fetchAheadSeconds * settings.groupsPerSecond
                const maxGroupToFetch = currentGroup + fetchAheadGroups

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
  }, [handleSeeking, handleTimeUpdate, videoUrl]) // Re-attach when video is available

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
        {!hasJoinedRoom && (
          <form>
            <div style={{ marginTop: '10px', display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                onClick={handleSubscribeClick}
                className="mp4-requester-button"
              >
                Subscribe
              </button>
              {showJoinRoom && (
                <button
                  type="button"
                  onClick={handleJoinRoomClick}
                  className="mp4-requester-button"
                >
                  Join Room
                </button>
              )}
            </div>
          </form>
        )}

        {requestState.error && (
          <div className="mp4-requester-error">
            Request failed: {requestState.error}
          </div>
        )}

        {requestState.isLoading && (
          <div style={{ marginTop: '20px', textAlign: 'center' }}>
            Loading video...
          </div>
        )}

        {/* Playback Info Display */}
        {hasJoinedRoom && (
          <div style={{
            marginTop: '20px',
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
                <strong>Buffered Groups (approx):</strong> {bufferedRangesRef.current.size}
              </div>
              <div style={{ fontSize: '0.9em', color: '#666', marginTop: '8px' }}>
                Formula: Time {currentTime.toFixed(2)}s → Group {currentGroup} (= ⌊{currentTime.toFixed(2)} × {settings.groupsPerSecond}⌋)
              </div>
            </div>
          </div>
        )}

        {videoUrl && (
          <div className="mp4-requester-video-container">
            <video
              ref={videoRef}
              controls
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