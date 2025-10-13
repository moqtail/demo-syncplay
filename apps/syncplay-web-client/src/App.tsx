import { useState, useRef } from 'react'
import type { FragmentRange, RequestState } from './types'
import { requestFragmentRange, requestFragmentRangeWithFetch } from './api'
import './MP4Requester.css'

function App() {
  const [range, setRange] = useState<FragmentRange>({
    startGroupId: 0,
    startObjectId: 0,
    endGroupId: 1,
    endObjectId: 0,
  })
  
  const [requestState, setRequestState] = useState<RequestState>({
    isLoading: false,
    error: null,
  })
  
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [useFetchProtocol, setUseFetchProtocol] = useState<boolean>(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  const handleInputChange = (field: keyof FragmentRange) => (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const value = parseInt(e.target.value)
    setRange(prev => ({ ...prev, [field]: value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    setRequestState({ isLoading: true, error: null })
    
    try {
      // Choose the appropriate API based on the protocol selection
      const blob = useFetchProtocol 
        ? await requestFragmentRangeWithFetch(range)
        : await requestFragmentRange(range)
      
      const url = URL.createObjectURL(blob)
      
      // Clean up previous video URL
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl)
      }
      
      setVideoUrl(url)
      
      // Auto-play the video
      if (videoRef.current) {
        videoRef.current.play()
      }
      
      setRequestState({ isLoading: false, error: null })
    } catch (err) {
      setRequestState({ 
        isLoading: false, 
        error: err instanceof Error ? err.message : 'An unknown error occurred'
      })
    }
  }

  return (
    <div className="mp4-requester-container">
      <div className="mp4-requester-content">
        <h1 className="mp4-requester-title">MP4 Fragment Range Requester</h1>

        <div className="mp4-requester-info-box">
          <h4>How to use:</h4>
          <p>
            This interface allows you to request specific ranges of MP4 fragments
            from the server. Enter the start and end group/object IDs to request a
            range of video fragments.
          </p>
          <p>
            <strong>Note:</strong> The server will send the init segment followed
            by the requested fragment range.
          </p>
        </div>

        <div className="mp4-requester-form-group">
          <label className="mp4-requester-label">
            <input
              type="checkbox"
              checked={useFetchProtocol}
              onChange={(e) => setUseFetchProtocol(e.target.checked)}
              style={{ marginRight: '8px' }}
            />
            Use MoQ Fetch Protocol (serialized Fetch/FetchObject)
          </label>
          <p style={{ fontSize: '14px', color: '#666', marginTop: '5px' }}>
            {useFetchProtocol 
              ? 'Using POST /fetch with serialized MoQ Fetch request and FetchObject response'
              : 'Using GET /range with query parameters and raw MP4 response'
            }
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mp4-requester-range-inputs">
            <div className="mp4-requester-range-group">
              <h3>Start Range</h3>
              <div className="mp4-requester-form-group">
                <label htmlFor="startGroupId" className="mp4-requester-label">
                  Start Group ID:
                </label>
                <input
                  type="number"
                  id="startGroupId"
                  min="0"
                  value={range.startGroupId}
                  onChange={handleInputChange('startGroupId')}
                  className="mp4-requester-input"
                  required
                />
              </div>
              <div className="mp4-requester-form-group">
                <label htmlFor="startObjectId" className="mp4-requester-label">
                  Start Object ID:
                </label>
                <input
                  type="number"
                  id="startObjectId"
                  min="0"
                  value={range.startObjectId}
                  onChange={handleInputChange('startObjectId')}
                  className="mp4-requester-input"
                  required
                />
              </div>
            </div>

            <div className="mp4-requester-range-group">
              <h3>End Range</h3>
              <div className="mp4-requester-form-group">
                <label htmlFor="endGroupId" className="mp4-requester-label">
                  End Group ID:
                </label>
                <input
                  type="number"
                  id="endGroupId"
                  min="0"
                  value={range.endGroupId}
                  onChange={handleInputChange('endGroupId')}
                  className="mp4-requester-input"
                  required
                />
              </div>
              <div className="mp4-requester-form-group">
                <label htmlFor="endObjectId" className="mp4-requester-label">
                  End Object ID:
                </label>
                <input
                  type="number"
                  id="endObjectId"
                  min="0"
                  value={range.endObjectId}
                  onChange={handleInputChange('endObjectId')}
                  className="mp4-requester-input"
                  required
                />
              </div>
            </div>
          </div>

          <button 
            type="submit" 
            disabled={requestState.isLoading}
            className="mp4-requester-button"
          >
            {requestState.isLoading ? 'Requesting...' : 'Request Fragment Range'}
          </button>
        </form>

        {requestState.error && (
          <div className="mp4-requester-error">
            Request failed: {requestState.error}
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
