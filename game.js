import { db } from "./firebase-config.js";
import { state } from "./state.js";
import {
  doc, getDoc, setDoc, updateDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const screenGame = document.getElementById("screen-game");
const boardEl = document.getElementById("game-board");
const statusEl = document.getElementById("game-status");
let unsubGame = null;

const WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8], // rows
  [0,3,6],[1,4,7],[2,5,8], // cols
  [0,4,8],[2,4,6]          // diagonals
];

function checkWinner(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return board.every(c => c) ? "draw" : null;
}

function gameRef() {
  // NOTE: currently scoped to 1:1 chats only — group game support is a
  // natural next step but needs a "pick your opponent" step first.
  return doc(db, "chats", state.activeChatId, "game", "state");
}

document.getElementById("btn-attach-game")?.addEventListener("click", async (e) => {
  e.stopPropagation();
  document.getElementById("attach-menu").hidden = true;

  if (!state.activeChatId) return;
  if (!state.activePeer?.uid) {
    alert("Games currently work in 1:1 conversations only — group game support is coming later.");
    return;
  }

  screenGame.hidden = false;
  screenGame.classList.add("active");

  const ref = gameRef();
  const snap = await getDoc(ref).catch(() => null);
  if (!snap || !snap.exists()) {
    await setDoc(ref, {
      board: Array(9).fill(null),
      players: [state.user.uid, state.activePeer.uid], // players[0] = X, players[1] = O
      turn: state.user.uid,
      winner: null
    }).catch(err => console.error("Failed to start game:", err));
  }

  if (unsubGame) unsubGame();
  unsubGame = onSnapshot(ref, (s) => renderGame(s.data()), (err) => console.error("Game listener failed:", err));
});

function renderGame(g) {
  if (!g) return;
  const mySymbol = g.players[0] === state.user.uid ? "X" : "O";
  boardEl.innerHTML = "";
  g.board.forEach((val, i) => {
    const cell = document.createElement("button");
    cell.className = "game-cell";
    cell.textContent = val || "";
    cell.disabled = !!val || !!g.winner || g.turn !== state.user.uid;
    cell.addEventListener("click", () => makeMove(g, i, mySymbol));
    boardEl.appendChild(cell);
  });

  if (g.winner === "draw") statusEl.textContent = "It's a draw.";
  else if (g.winner) statusEl.textContent = (g.winner === mySymbol) ? "You won! 🎉" : "You lost.";
  else statusEl.textContent = (g.turn === state.user.uid) ? `Your turn (${mySymbol})` : "Their turn…";
}

async function makeMove(g, index, mySymbol) {
  if (g.board[index] || g.winner || g.turn !== state.user.uid) return;
  const board = [...g.board];
  board[index] = mySymbol;
  const winner = checkWinner(board);
  const otherUid = g.players.find(u => u !== state.user.uid);
  try {
    await updateDoc(gameRef(), { board, winner, turn: winner ? g.turn : otherUid });
  } catch (err) {
    console.error("Move failed:", err);
  }
}

document.getElementById("btn-game-restart")?.addEventListener("click", async () => {
  if (!state.activeChatId) return;
  try {
    await updateDoc(gameRef(), { board: Array(9).fill(null), winner: null, turn: state.user.uid });
  } catch (err) {
    console.error("Restart failed:", err);
  }
});

document.getElementById("btn-close-game")?.addEventListener("click", () => {
  screenGame.hidden = true;
  screenGame.classList.remove("active");
  if (unsubGame) { unsubGame(); unsubGame = null; }
});
