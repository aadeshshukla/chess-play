import { useState, useEffect, useRef, useCallback } from 'react'
import { Chessboard } from 'react-chessboard'
import { Chess } from 'chess.js'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function findKingSquare(chess, color) {
  const board = chess.board()
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c]
      if (p && p.type === 'k' && p.color === color) {
        return String.fromCharCode(97 + c) + (8 - r)
      }
    }
  }
  return null
}

function getPieceUnicode(type, color) {
  const map = {
    p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚'
  }
  let sym = map[type] || '?'
  // For display we can leave as-is; CSS will color if needed
  return sym
}

function createAudioBeep(freq, duration, type = 'square', volume = 0.18) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    const ctx = new AC()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const filt = ctx.createBiquadFilter()

    osc.type = type
    osc.frequency.value = freq
    filt.type = 'lowpass'
    filt.frequency.value = 1400
    gain.gain.value = volume

    const t = ctx.currentTime
    osc.connect(filt)
    filt.connect(gain)
    gain.connect(ctx.destination)

    osc.start(t)
    gain.gain.linearRampToValueAtTime(0.0001, t + duration)
    osc.stop(t + duration + 0.03)
  } catch (e) {
    // silent fail
  }
}

function playMoveSound(move, isCheck, isGameEnd = false) {
  if (isGameEnd) return
  const flags = move.flags || ''
  if (flags.includes('p')) {
    createAudioBeep(920, 0.32, 'sine', 0.22)
    return
  }
  if (flags.includes('c') || flags.includes('e')) {
    createAudioBeep(340, 0.16, 'sawtooth', 0.16)
    return
  }
  if (flags.includes('k') || flags.includes('q')) {
    createAudioBeep(680, 0.11, 'square', 0.15)
    return
  }
  createAudioBeep(560, 0.07, 'square', 0.12)
}

function playGameEndSound(outcome, playerColor) {
  if (!outcome) return
  const lower = outcome.toLowerCase()
  if (lower.includes('draw')) {
    createAudioBeep(420, 0.55, 'sine', 0.2)
    return
  }
  const iWon = (lower.includes('white') && playerColor === 'white') ||
               (lower.includes('black') && playerColor === 'black')
  if (iWon) {
    // ascending win chime
    createAudioBeep(660, 0.18, 'sine', 0.22)
    setTimeout(() => createAudioBeep(880, 0.32, 'sine', 0.22), 160)
  } else {
    createAudioBeep(220, 0.7, 'sawtooth', 0.18)
  }
}

export default function Game({ socket, roomId, initData, playerColor, onLeave }) {
  const [game, setGame] = useState(() => new Chess(initData?.fen || START_FEN))
  const [fen, setFen] = useState(initData?.fen || START_FEN)
  const [moveHistory, setMoveHistory] = useState([])
  const [captured, setCaptured] = useState({ white: [], black: [] })
  const [gameOver, setGameOver] = useState(false)
  const [gameOverData, setGameOverData] = useState(null)
  const [status, setStatus] = useState('')
  const [rematchRequested, setRematchRequested] = useState(false)
  const [time, setTime] = useState(initData?.time || { w: 300000, b: 300000 })
  const [boardWidth, setBoardWidth] = useState(520)
  const [optionSquares, setOptionSquares] = useState({})
  const [lastMove, setLastMove] = useState(null)
  const [selectedSquare, setSelectedSquare] = useState(null)
  const [pendingPromotion, setPendingPromotion] = useState(null)
  const [boardOrientation, setBoardOrientation] = useState(playerColor || 'white')

  // Sync board orientation whenever playerColor prop changes (covers rematch color swap)
  useEffect(() => {
    if (playerColor) setBoardOrientation(playerColor)
  }, [playerColor])
  const [drawOfferedBy, setDrawOfferedBy] = useState(null)
  const [hasGameStarted, setHasGameStarted] = useState(false)

  const boardWrapperRef = useRef(null)
  const moveListRef = useRef(null)

  // Resize board
  useEffect(() => {
    const handleResize = () => {
      if (boardWrapperRef.current) {
        const maxW = Math.min(boardWrapperRef.current.offsetWidth, 620)
        const fromH = Math.min(window.innerHeight * 0.68, 620)
        setBoardWidth(Math.min(maxW, fromH))
      }
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Auto scroll move list
  useEffect(() => {
    if (moveListRef.current) {
      moveListRef.current.scrollTop = moveListRef.current.scrollHeight
    }
  }, [moveHistory])

  // Reset everything when we get a brand new game (rematch or fresh start)
  useEffect(() => {
    if (!initData) return

    const isStartingPosition = initData.fen === START_FEN || (initData.fen && initData.fen.includes('rnbqkbnr/pppppppp'))

    if (isStartingPosition) {
      const fresh = new Chess(initData.fen)
      setGame(fresh)
      setFen(initData.fen)
      setMoveHistory([])
      setCaptured({ white: [], black: [] })
      setGameOver(false)
      setGameOverData(null)
      setStatus('')
      setRematchRequested(false)
      setTime(initData.time || { w: initData.timeMode * 60000, b: initData.timeMode * 60000 })
      setOptionSquares({})
      setLastMove(null)
      setSelectedSquare(null)
      setPendingPromotion(null)
      setBoardOrientation(playerColor)
      setDrawOfferedBy(null)
      setHasGameStarted(false)
    }
  }, [initData?.fen, roomId, playerColor])

  // Socket listeners
  useEffect(() => {
    if (!socket) return

    const onTime = (newTime) => setTime(newTime)

    const onMoveMade = ({ fen: newFen, move, san }) => {
      game.load(newFen)
      setFen(newFen)
      setLastMove([move.from, move.to])
      setHasGameStarted(true)
      setOptionSquares({})
      setSelectedSquare(null)
      setPendingPromotion(null)

      // Update history
      if (move) {
        setMoveHistory(prev => {
          // avoid duplicates if we already added locally
          const last = prev[prev.length - 1]
          if (last && last.from === move.from && last.to === move.to) return prev
          return [...prev, move]
        })

        // Captured pieces
        if (move.captured) {
          const capturerIsWhite = move.color === 'w'
          setCaptured(prev => ({
            white: capturerIsWhite ? [...prev.white, move.captured] : prev.white,
            black: !capturerIsWhite ? [...prev.black, move.captured] : prev.black
          }))
        }

        // Sound (only for opponent's moves — we already played locally for ours)
        if (move.color !== playerColor[0]) {
          const isCheckNow = game.inCheck()
          playMoveSound(move, isCheckNow)
        }
      }

      // If this move put opponent in check, slight delay for check sound
      if (game.inCheck()) {
        setTimeout(() => createAudioBeep(740, 0.22, 'square', 0.17), 80)
      }
    }

    const onGameOver = (data) => {
      setGameOver(true)
      setGameOverData(data)
      const nice = data.outcome || 'GAME OVER'
      setStatus(nice.toUpperCase())
      playGameEndSound(data.outcome || data.reason, playerColor)
    }

    const onAbandoned = () => {
      setStatus('GAME ABANDONED')
      setGameOver(true)
      setGameOverData({ outcome: 'Game abandoned', reason: 'abandoned' })
    }

    const onRematchReq = () => setRematchRequested(true)

    const onPlayerLeft = () => {
      setStatus('OPPONENT LEFT')
      setGameOver(true)
      setGameOverData({ outcome: 'Opponent left', reason: 'left' })
    }

    const onDrawOffered = ({ from }) => {
      setDrawOfferedBy(from)
    }

    const onDrawDeclined = () => {
      setDrawOfferedBy(null)
      // subtle feedback
      setStatus('Draw declined')
      setTimeout(() => {
        if (!gameOver) setStatus('')
      }, 1400)
    }

    socket.on('time_update', onTime)
    socket.on('move_made', onMoveMade)
    socket.on('game_over', onGameOver)
    socket.on('game_abandoned', onAbandoned)
    socket.on('rematch_requested', onRematchReq)
    socket.on('player_left', onPlayerLeft)
    socket.on('draw_offered', onDrawOffered)
    socket.on('draw_declined', onDrawDeclined)

    return () => {
      socket.off('time_update', onTime)
      socket.off('move_made', onMoveMade)
      socket.off('game_over', onGameOver)
      socket.off('game_abandoned', onAbandoned)
      socket.off('rematch_requested', onRematchReq)
      socket.off('player_left', onPlayerLeft)
      socket.off('draw_offered', onDrawOffered)
      socket.off('draw_declined', onDrawDeclined)
    }
  }, [socket, game, playerColor, gameOver])

  // === MOVE HELPERS ===

  const updateLocalAfterMove = useCallback((moveResult) => {
    setFen(game.fen())
    setLastMove([moveResult.from, moveResult.to])
    setHasGameStarted(true)

    setMoveHistory(prev => {
      const last = prev[prev.length - 1]
      if (last && last.from === moveResult.from && last.to === moveResult.to) return prev
      return [...prev, moveResult]
    })

    if (moveResult.captured) {
      const capturerWhite = moveResult.color === 'w'
      setCaptured(prev => ({
        white: capturerWhite ? [...prev.white, moveResult.captured] : prev.white,
        black: !capturerWhite ? [...prev.black, moveResult.captured] : prev.black
      }))
    }

    playMoveSound(moveResult, game.inCheck())
    if (game.inCheck()) {
      setTimeout(() => createAudioBeep(740, 0.22, 'square', 0.17), 70)
    }
  }, [game])

  function attemptMove(from, to, promotion = null) {
    if (gameOver || game.turn() !== playerColor[0]) return false

    const piece = game.get(from)
    const needsPromotion = piece &&
      piece.type === 'p' &&
      ((piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1'))

    if (needsPromotion && promotion === null) {
      // Ask user to pick promotion piece
      setPendingPromotion({ from, to })
      setOptionSquares({})
      setSelectedSquare(null)
      return false
    }

    try {
      const moveResult = game.move({ from, to, promotion: promotion || 'q' })
      if (!moveResult) return false

      updateLocalAfterMove(moveResult)
      setOptionSquares({})
      setSelectedSquare(null)

      socket.emit('move', {
        roomId,
        move: { from, to, promotion: promotion || 'q' }
      })
      return true
    } catch (e) {
      return false
    }
  }

  function confirmPromotion(piece) {
    if (!pendingPromotion) return
    const { from, to } = pendingPromotion
    setPendingPromotion(null)

    // Perform the real move now
    try {
      const moveResult = game.move({ from, to, promotion: piece })
      if (!moveResult) return

      updateLocalAfterMove(moveResult)
      setOptionSquares({})
      setSelectedSquare(null)

      socket.emit('move', { roomId, move: { from, to, promotion: piece } })
    } catch (e) {
      // invalid (shouldn't happen)
    }
  }

  function cancelPromotion() {
    setPendingPromotion(null)
    setOptionSquares({})
    setSelectedSquare(null)
  }

  // Highlight legal moves for a square
  function highlightLegal(square) {
    if (!square) {
      setOptionSquares({})
      return
    }
    const moves = game.moves({ square, verbose: true })
    if (moves.length === 0) {
      setOptionSquares({})
      return
    }

    const newStyles = {}
    moves.forEach((m) => {
      newStyles[m.to] = {
        background: game.get(m.to)
          ? 'radial-gradient(circle, rgba(0,0,0,0.18) 78%, transparent 82%)'
          : 'radial-gradient(circle, rgba(0,0,0,0.22) 22%, transparent 26%)',
        borderRadius: '50%'
      }
    })
    // selected origin
    newStyles[square] = { background: 'rgba(255, 215, 0, 0.38)' }
    setOptionSquares(newStyles)
  }

  // === INPUT HANDLERS (Lichess-like) ===

  function onSquareClick(square) {
    if (gameOver || game.turn() !== playerColor[0]) {
      setSelectedSquare(null)
      setOptionSquares({})
      return
    }

    const piece = game.get(square)

    // If we have a selected piece, try to move there
    if (selectedSquare) {
      if (square === selectedSquare) {
        // clicking same square deselects
        setSelectedSquare(null)
        setOptionSquares({})
        return
      }

      const legalMoves = game.moves({ square: selectedSquare, verbose: true })
      const isLegalTarget = legalMoves.some(m => m.to === square)

      if (isLegalTarget) {
        attemptMove(selectedSquare, square)
      } else if (piece && piece.color === playerColor[0]) {
        // clicked another of our pieces -> reselect
        setSelectedSquare(square)
        highlightLegal(square)
      } else {
        setSelectedSquare(null)
        setOptionSquares({})
      }
      return
    }

    // No selection yet - select our piece
    if (piece && piece.color === playerColor[0]) {
      setSelectedSquare(square)
      highlightLegal(square)
    } else {
      setSelectedSquare(null)
      setOptionSquares({})
    }
  }

  function onPieceDragBegin(piece, sourceSquare) {
    if (gameOver || game.turn() !== playerColor[0]) return false
    // Only allow dragging our pieces
    const pieceOnSq = game.get(sourceSquare)
    if (!pieceOnSq || pieceOnSq.color !== playerColor[0]) return false

    setSelectedSquare(sourceSquare)
    highlightLegal(sourceSquare)
    return true
  }

  function onDrop(sourceSquare, targetSquare) {
    if (gameOver || game.turn() !== playerColor[0]) return false

    // Clear any previous selection UI
    setSelectedSquare(null)

    const piece = game.get(sourceSquare)
    const isPromotion = piece &&
      piece.type === 'p' &&
      ((piece.color === 'w' && targetSquare[1] === '8') || (piece.color === 'b' && targetSquare[1] === '1'))

    if (isPromotion) {
      // Check it's actually a legal move before showing modal
      const legalMoves = game.moves({ square: sourceSquare, verbose: true })
      const isLegal = legalMoves.some(m => m.to === targetSquare)
      if (!isLegal) return false
      setPendingPromotion({ from: sourceSquare, to: targetSquare })
      setOptionSquares({})
      return false // snap back; confirmPromotion will execute the real move
    }

    return attemptMove(sourceSquare, targetSquare)
  }

  function onSquareRightClick() {
    // Cancel selection / highlights
    setSelectedSquare(null)
    setOptionSquares({})
  }

  // === ACTIONS ===

  const handleResign = () => {
    if (gameOver) return
    socket.emit('resign', { roomId })
  }

  const handleOfferDraw = () => {
    if (gameOver) return
    socket.emit('offer_draw', { roomId })
    setDrawOfferedBy('me')
  }

  const handleAcceptDraw = () => {
    socket.emit('accept_draw', { roomId })
    setDrawOfferedBy(null)
  }

  const handleDeclineDraw = () => {
    socket.emit('decline_draw', { roomId })
    setDrawOfferedBy(null)
  }

  const handleRematch = () => {
    socket.emit('rematch', { roomId })
  }

  const handleAbort = () => {
    socket.emit('abort', { roomId })
  }

  const toggleFlip = () => {
    setBoardOrientation(prev => (prev === 'white' ? 'black' : 'white'))
  }

  const copyFEN = () => {
    navigator.clipboard.writeText(fen).catch(() => {})
  }

  const copyPGN = () => {
    try {
      // chess.js can generate PGN from current game state
      const pgn = game.pgn()
      navigator.clipboard.writeText(pgn || '[Event "ChessMate"]\n' + fen).catch(() => {})
    } catch (e) {
      navigator.clipboard.writeText(fen).catch(() => {})
    }
  }

  // === DERIVED ===

  const isMyTurn = game.turn() === playerColor[0]
  const opponentColor = playerColor === 'white' ? 'black' : 'white'
  const inCheck = game.inCheck() && !gameOver

  // Build nice custom square styles (last move + check + options)
  const customSquareStyles = {
    ...optionSquares,
    ...(lastMove ? {
      [lastMove[0]]: { background: 'rgba(245, 215, 85, 0.42)' },
      [lastMove[1]]: { background: 'rgba(245, 215, 85, 0.42)' }
    } : {})
  }

  if (inCheck) {
    const kingSq = findKingSquare(game, game.turn())
    if (kingSq) {
      customSquareStyles[kingSq] = {
        background: 'radial-gradient(circle, rgba(220, 30, 30, 0.72) 38%, transparent 46%)',
        boxShadow: 'inset 0 0 0 3.5px rgba(255,60,60,0.85)'
      }
    }
  }

  const formatTime = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const canAbort = !hasGameStarted && !gameOver

  // Move list rendering (pairs)
  const movePairs = []
  for (let i = 0; i < moveHistory.length; i += 2) {
    movePairs.push({
      num: Math.floor(i / 2) + 1,
      white: moveHistory[i],
      black: moveHistory[i + 1]
    })
  }

  const PlayerPlate = ({ name, color, timeMs, isActive }) => (
    <div className={`player-plate ${isActive ? 'active' : ''}`}>
      <div className="player-info">
        <div className={`player-avatar ${color}`}>
          {color[0].toUpperCase()}
        </div>
        <div className="player-name">
          {name} {color === playerColor ? '(You)' : ''}
        </div>
      </div>
      <div className={`player-timer ${timeMs < 10000 && isActive ? 'low' : ''}`}>
        {formatTime(timeMs)}
      </div>
    </div>
  )

  // Captured pieces row
  const CapturedRow = ({ pieces, side }) => (
    <div className={`captured-row ${side}`}>
      {pieces.length === 0 && <span className="captured-empty">—</span>}
      {pieces.map((p, idx) => (
        <span key={idx} className={`captured-piece ${side}`}>{getPieceUnicode(p, side === 'white' ? 'b' : 'w')}</span>
      ))}
    </div>
  )

  return (
    <div className="app-container">
      <header className="header">
        <h1 className="logo">♟ ChessMate</h1>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button className="button button-secondary" onClick={toggleFlip} title="Flip board">Flip</button>
          <button className="button button-secondary" onClick={onLeave}>Leave</button>
        </div>
      </header>

      <main className="main-layout">
        {/* BOARD + CAPTURES */}
        <div className="board-column" ref={boardWrapperRef}>
          <div className="player-above">
            <PlayerPlate
              name="Opponent"
              color={opponentColor}
              timeMs={time[opponentColor[0]]}
              isActive={game.turn() === opponentColor[0] && !gameOver && hasGameStarted}
            />
            {/* Show pieces *we* captured from the opponent (they appear in our captured list of their color) */}
            <CapturedRow pieces={captured[playerColor]} side={opponentColor} />
          </div>

          <div className="board-container">
            <Chessboard
              position={fen}
              onPieceDrop={onDrop}
              onSquareClick={onSquareClick}
              onPieceDragBegin={onPieceDragBegin}
              onSquareRightClick={onSquareRightClick}
              boardOrientation={boardOrientation}
              boardWidth={boardWidth}
              arePiecesDraggable={!gameOver}
              isDraggablePiece={({ piece, sourceSquare }) => {
                // Only allow dragging your own pieces on your turn
                const colorChar = playerColor === 'white' ? 'w' : 'b'
                return !gameOver && game.turn() === playerColor[0] && piece[0].toLowerCase() === colorChar
              }}
              customDarkSquareStyle={{ backgroundColor: 'var(--board-dark)' }}
              customLightSquareStyle={{ backgroundColor: 'var(--board-light)' }}
              customSquareStyles={customSquareStyles}
              animationDuration={180}
            />
          </div>

          <div className="player-below">
            {/* Show pieces opponent captured from us */}
            <CapturedRow pieces={captured[opponentColor]} side={playerColor} />
            <PlayerPlate
              name="You"
              color={playerColor}
              timeMs={time[playerColor[0]]}
              isActive={isMyTurn && !gameOver && hasGameStarted}
            />
          </div>
        </div>

        {/* SIDEBAR */}
        <aside className="sidebar">
          <div className="game-info-bar">
            <div>{initData?.timeMode || 5} min</div>
            <div className="room-code" onClick={() => navigator.clipboard.writeText(roomId)} title="Copy room code">
              {roomId}
            </div>
          </div>

          <div className="game-status">
            {gameOver ? (
              <div style={{ color: 'var(--text-bright)' }}>{status}</div>
            ) : drawOfferedBy && drawOfferedBy !== 'me' ? (
              <div style={{ color: 'var(--accent-color)' }}>Draw offered</div>
            ) : (
              <div className={isMyTurn ? 'my-turn' : ''}>
                {isMyTurn ? 'Your turn' : "Opponent's turn"}
                {inCheck && ' • Check!'}
              </div>
            )}
          </div>

          {/* MOVE LIST */}
          <div className="move-list-container">
            <div className="move-list-header">
              <span>Moves</span>
              <span style={{ display: 'flex', gap: '6px' }}>
                <button className="mini-btn" onClick={copyFEN} title="Copy FEN">FEN</button>
                <button className="mini-btn" onClick={copyPGN} title="Copy PGN">PGN</button>
              </span>
            </div>
            <div className="move-list" ref={moveListRef}>
              {movePairs.length === 0 && (
                <div className="move-list-empty">Game moves will appear here</div>
              )}
              {movePairs.map((pair, idx) => (
                <div key={idx} className="move-row">
                  <span className="move-num">{pair.num}.</span>
                  <span className="move-san">{pair.white?.san || ''}</span>
                  <span className="move-san">{pair.black?.san || ''}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ACTIONS */}
          <div className="actions">
            {!gameOver && (
              <>
                {canAbort && (
                  <button className="button button-secondary" onClick={handleAbort}>
                    Abort
                  </button>
                )}
                <button className="button button-secondary" onClick={handleResign}>
                  Resign
                </button>
                <button
                  className="button button-secondary"
                  onClick={handleOfferDraw}
                  disabled={!!drawOfferedBy}
                >
                  {drawOfferedBy === 'me' ? 'Draw sent' : 'Offer Draw'}
                </button>
                <button className="button button-secondary" onClick={toggleFlip}>
                  Flip Board
                </button>
              </>
            )}

            {gameOver && (
              <>
                <button className="button button-primary" onClick={handleRematch}>
                  {rematchRequested ? 'Accept Rematch' : 'Rematch'}
                </button>
                <button className="button button-secondary" onClick={onLeave}>
                  Back to Home
                </button>
              </>
            )}
          </div>

          {/* Draw offer prompt (when opponent offered) */}
          {!gameOver && drawOfferedBy && drawOfferedBy !== 'me' && (
            <div className="draw-offer-box">
              <div>Opponent offered a draw</div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button className="button button-primary" style={{ flex: 1 }} onClick={handleAcceptDraw}>
                  Accept
                </button>
                <button className="button button-secondary" style={{ flex: 1 }} onClick={handleDeclineDraw}>
                  Decline
                </button>
              </div>
            </div>
          )}
        </aside>
      </main>

      {/* Promotion chooser modal */}
      {pendingPromotion && (
        <div className="overlay" onClick={cancelPromotion}>
          <div className="modal promotion-modal" onClick={e => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Promote to</h3>
            <div className="promotion-choices">
              {['q', 'r', 'b', 'n'].map(p => (
                <button
                  key={p}
                  className="promo-btn"
                  onClick={() => confirmPromotion(p)}
                >
                  {playerColor === 'white' ? (
                    { q: '♕', r: '♖', b: '♗', n: '♘' }[p]
                  ) : (
                    { q: '♛', r: '♜', b: '♝', n: '♞' }[p]
                  )}
                </button>
              ))}
            </div>
            <button className="button button-secondary" style={{ marginTop: '1rem' }} onClick={cancelPromotion}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Game over modal (nice centered) */}
      {gameOver && gameOverData && (
        <div className="overlay">
          <div className="modal">
            <h2>Game Over</h2>
            <p style={{ fontSize: '1.35rem', margin: '0.6rem 0 1.25rem', color: 'var(--accent-color)', fontWeight: 600 }}>
              {status}
            </p>
            {gameOverData.reason && (
              <p style={{ fontSize: '0.9rem', color: '#888', marginBottom: '1rem' }}>
                {gameOverData.reason === 'checkmate' && 'Checkmate'}
                {gameOverData.reason === 'time' && 'Time expired'}
                {gameOverData.reason === 'resignation' && 'Resignation'}
                {gameOverData.reason === 'agreement' && 'Draw by agreement'}
                {gameOverData.reason === 'stalemate' && 'Stalemate'}
                {gameOverData.reason === 'repetition' && 'Threefold repetition'}
                {gameOverData.reason === 'insufficient material' && 'Insufficient material'}
                {gameOverData.reason === 'aborted' && 'Game aborted'}
                {gameOverData.reason === 'left' && 'Opponent disconnected'}
              </p>
            )}
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button className="button button-primary" style={{ flex: 1 }} onClick={handleRematch}>
                {rematchRequested ? 'Accept Rematch' : 'Rematch'}
              </button>
              <button className="button button-secondary" style={{ flex: 1 }} onClick={onLeave}>
                Home
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}