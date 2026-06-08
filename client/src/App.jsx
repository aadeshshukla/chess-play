import { useState, useEffect } from 'react'
import { io } from 'socket.io-client'
import Home from './components/Home'
import Game from './components/Game'

// Connect to the server
const socket = io('http://localhost:3001')

export default function App() {
  const [screen, setScreen] = useState('home')
  const [roomId, setRoomId] = useState('')
  const [error, setError] = useState('')
  const [gameInitData, setGameInitData] = useState(null)
  const [playerColor, setPlayerColor] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [gameVersion, setGameVersion] = useState(0)

  useEffect(() => {
    socket.on('room_created', ({ roomId, color }) => {
      setRoomId(roomId)
      setPlayerColor(color)
      setScreen('waiting')
      setIsLoading(false)
    })

    socket.on('room_joined', ({ roomId, color }) => {
      setRoomId(roomId)
      if (color) {
        setPlayerColor(color)
      }
      setIsLoading(false)
    })

    socket.on('searching', () => {
      setScreen('searching')
      setIsLoading(false)
    })

    socket.on('game_start', (data) => {
      // Robustly determine our color from authoritative server data
      let color = ''
      if (data.white === socket.id) color = 'white'
      else if (data.black === socket.id) color = 'black'

      if (color) setPlayerColor(color)
      setGameInitData(data)
      setScreen('game')
      // Bump version so Game component fully remounts on rematch / new games
      setGameVersion(v => v + 1)
    })

    socket.on('error', (msg) => {
      setError(msg)
      setScreen('home')
      setIsLoading(false)
    })

    return () => {
      socket.off('room_created')
      socket.off('room_joined')
      socket.off('searching')
      socket.off('game_start')
      socket.off('error')
    }
  }, [])

  const handleCreateRoom = (timeMode) => {
    setError('')
    setIsLoading(true)
    socket.emit('create_room', { timeMode })
  }

  const handleJoinRoom = (id) => {
    if (!id.trim()) return setError('Enter a room code')
    setError('')
    setIsLoading(true)
    socket.emit('join_room', { roomId: id.trim() })
  }

  const handleFindRandom = (timeMode) => {
    setError('')
    setIsLoading(true)
    socket.emit('find_random_match', { timeMode })
  }

  const handleCancelSearch = () => {
    socket.emit('cancel_search')
    setScreen('home')
    setIsLoading(false)
  }

  const handleLeaveGame = () => {
    // Clean reset without full page reload
    setScreen('home')
    setRoomId('')
    setGameInitData(null)
    setPlayerColor('')
    setError('')
    setGameVersion(0)
  }

  if (isLoading) {
    return (
      <div className="app-container">
        <h1 className="logo">♟ ChessMate</h1>
        <div className="home-card" style={{ alignItems: 'center' }}>
          <div className="loader"></div>
          <p>Connecting...</p>
        </div>
      </div>
    )
  }

  if (screen === 'searching') {
    return (
      <div className="app-container">
        <h1 className="logo">♟ ChessMate</h1>
        <div className="home-card" style={{ alignItems: 'center' }}>
          <h2>Searching</h2>
          <p>Finding an opponent...</p>
          <div className="loader" style={{ margin: '2rem 0' }}></div>
          <button className="button button-secondary" onClick={handleCancelSearch}>Cancel</button>
        </div>
      </div>
    )
  }

  if (screen === 'waiting') {
    return (
      <div className="app-container">
        <h1 className="logo">♟ ChessMate</h1>
        <div className="home-card" style={{ alignItems: 'center' }}>
          <p>Share this code with a friend:</p>
          <div className="input-field" style={{ fontSize: '2rem', padding: '1rem', width: '100%' }}>{roomId}</div>
          <button className="button button-primary" onClick={() => navigator.clipboard.writeText(roomId)} style={{ width: '100%' }}>Copy Code</button>
          <p style={{ color: '#555', fontSize: '0.85rem' }}>Waiting for opponent to join...</p>
          <div className="loader"></div>
        </div>
      </div>
    )
  }

  if (screen === 'game' && gameInitData && playerColor) {
    // gameVersion guarantees a fresh Game component on rematch (color swap + new game)
    const gameKey = `g-${roomId}-${gameVersion}`
    return (
      <Game
        key={gameKey}
        socket={socket}
        roomId={roomId}
        initData={gameInitData}
        playerColor={playerColor}
        onLeave={handleLeaveGame}
      />
    )
  }

  return (
    <div className="app-container">
      <header className="header">
        <h1 className="logo">♟ ChessMate</h1>
      </header>
      
      <Home 
        onCreateRoom={handleCreateRoom} 
        onJoinRoom={handleJoinRoom} 
        onFindRandom={handleFindRandom} 
      />

      {error && (
        <div className="overlay" onClick={() => setError('')}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2 style={{ color: 'var(--danger)' }}>Error</h2>
            <p>{error}</p>
            <button className="button button-primary" onClick={() => setError('')}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
