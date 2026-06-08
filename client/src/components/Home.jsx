import { useState } from 'react'

export default function Home({ onCreateRoom, onJoinRoom, onFindRandom }) {
  const [roomId, setRoomId] = useState('')
  const [joining, setJoining] = useState(false)
  const [timeMode, setTimeMode] = useState(5)

  return (
    <div className="home-card">
      <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
        <h2 style={{ color: 'var(--text-bright)', margin: 0 }}>Select Time Control</h2>
        <p style={{ fontSize: '0.9rem', color: '#777' }}>Minutes per side</p>
      </div>

      <div className="time-selector">
        {[3, 5, 10].map(mins => (
          <button
            key={mins}
            className={`time-option ${timeMode === mins ? 'active' : ''}`}
            onClick={() => setTimeMode(mins)}
          >
            {mins}m
          </button>
        ))}
      </div>

      <button className="button button-primary" onClick={() => onFindRandom(timeMode)}>
        Quick Match
      </button>

      <div style={{ textAlign: 'center', color: '#444', fontSize: '0.8rem', fontWeight: 'bold' }}>OR</div>

      <button className="button button-secondary" onClick={() => onCreateRoom(timeMode)}>
        Create Private Room
      </button>

      {!joining ? (
        <button className="button button-secondary" style={{ background: 'transparent', border: '1px solid #3c3934' }} onClick={() => setJoining(true)}>
          Join with Code
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <input 
            className="input-field"
            value={roomId} 
            onChange={e => setRoomId(e.target.value.toUpperCase())} 
            placeholder="ENTER CODE" 
            maxLength={8}
          />
          <button className="button button-primary" onClick={() => onJoinRoom(roomId)}>
            Join Now
          </button>
          <button className="button button-secondary" style={{ fontSize: '0.8rem' }} onClick={() => setJoining(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
