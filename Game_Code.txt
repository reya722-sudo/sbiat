import { useState, useEffect, useRef, useCallback, ReactNode, CSSProperties } from "react";
import { useToast } from "@/hooks/use-toast";
import { io, Socket } from "socket.io-client";
import arabiLogo from "@assets/العربي_1774297562184.png";
import saddLogo from "@assets/السد_1774297550784.jpg";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Users, Mic, MicOff, Trophy, RotateCcw, Play,
  ChevronRight, MessageCircle, X, Send, CheckCircle2,
  Clock, Crown, Shuffle, Star, Eye, LogOut, Volume2, VolumeX, Zap,
  Settings, Vibrate, Lightbulb, Maximize2, Minimize2, CreditCard, Sun, Moon,
  ArrowUpDown, Share2, History, Palette, Timer, Hexagon,
} from "lucide-react";

// ─── Card types ───────────────────────────────────────────────
const CARD_VALUES = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"];
const CARD_SUITS = ["♠", "♥", "♦", "♣"];
type CardStr = string; // e.g. "A♠", "10♥"

// Joker identifiers: B=black (lower), R=red (higher)
const JOKER_B = "🃏B"; // black joker — power 20
const JOKER_R = "🃏R"; // red joker  — power 21; cannot play until black joker seen

function buildDeck(playerCount: number): CardStr[] {
  // Cards excluded by rule per player count
  const EXCLUDE_4 = new Set(["2♦", "2♣"]); // removed in 4-player; replaced by jokers → 52 cards (13 each)
  const deck: CardStr[] = [];
  for (const suit of CARD_SUITS)
    for (const val of CARD_VALUES) {
      const card = val + suit;
      if (playerCount === 4 && EXCLUDE_4.has(card)) continue;
      deck.push(card);
    }
  // Both jokers added for all game sizes
  deck.push(JOKER_B, JOKER_R);
  // 4-player: 52 - 2 + 2 = 52 → 13 each ✓
  // 6-player: 52 + 2 = 54 → 9 each ✓
  return deck;
}

function seededShuffle(deck: CardStr[], seed: number): CardStr[] {
  const arr = [...deck];
  let s = seed >>> 0;
  for (let i = arr.length - 1; i > 0; i--) {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    s = ((s ^ (s >>> 14)) >>> 0);
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function dealHands(playerCount: number, seed: number): CardStr[][] {
  const deck = seededShuffle(buildDeck(playerCount), seed);
  const perPlayer = playerCount === 4 ? 13 : 9;
  return Array.from({ length: playerCount }, (_, i) =>
    deck.slice(i * perPlayer, (i + 1) * perPlayer)
  );
}

function sortHand(hand: CardStr[]): CardStr[] {
  // Alternating black–red–black–red: ♠(0) ♥(1) ♣(2) ♦(3)
  const suitOrder: Record<string, number> = { "♠": 0, "♥": 1, "♣": 2, "♦": 3 };
  const valOrder: Record<string, number> = {};
  CARD_VALUES.forEach((v, i) => (valOrder[v] = i));
  // Jokers go at the very end: black first, red after
  const jokerRank: Record<string, number> = { [JOKER_B]: 100, [JOKER_R]: 101 };
  return [...hand].sort((a, b) => {
    const jA = jokerRank[a] ?? 0, jB = jokerRank[b] ?? 0;
    if (jA || jB) return jA - jB;
    const sA = a.slice(-1), sB = b.slice(-1);
    const vA = a.slice(0, -1), vB = b.slice(0, -1);
    const sd = (suitOrder[sA] ?? 9) - (suitOrder[sB] ?? 9);
    return sd !== 0 ? sd : (valOrder[vA] ?? 99) - (valOrder[vB] ?? 99);
  });
}
function sortHandByRank(hand: CardStr[]): CardStr[] {
  const suitOrder: Record<string, number> = { "♠": 0, "♥": 1, "♣": 2, "♦": 3 };
  const valOrder: Record<string, number> = {};
  CARD_VALUES.forEach((v, i) => (valOrder[v] = i));
  const jokerRank: Record<string, number> = { [JOKER_B]: 100, [JOKER_R]: 101 };
  return [...hand].sort((a, b) => {
    const jA = jokerRank[a] ?? 0, jB = jokerRank[b] ?? 0;
    if (jA || jB) return jA - jB;
    const sA = a.slice(-1), sB = b.slice(-1);
    const vA = a.slice(0, -1), vB = b.slice(0, -1);
    const vd = (valOrder[vA] ?? 99) - (valOrder[vB] ?? 99);
    return vd !== 0 ? vd : (suitOrder[sA] ?? 9) - (suitOrder[sB] ?? 9);
  });
}

// ─── Trick-play utilities ─────────────────────────────────────
const TRUMP = "♠";
const RANK_VAL: Record<string, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
  "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14,
};
function cardSuit(c: CardStr) { return (c === JOKER_B || c === JOKER_R) ? TRUMP : c.slice(-1); }
function cardPower(c: CardStr) {
  if (c === JOKER_R) return 21; // red joker — beats everything
  if (c === JOKER_B) return 20; // black joker — beats all non-joker
  return RANK_VAL[c.slice(0, -1)] ?? 0;
}
function trickWinner(trick: { pi: number; card: CardStr }[]): number {
  let w = 0;
  for (let i = 1; i < trick.length; i++) {
    const s = cardSuit(trick[i].card), ws = cardSuit(trick[w].card);
    if (s === TRUMP && ws !== TRUMP) { w = i; }
    else if (s === ws && cardPower(trick[i].card) > cardPower(trick[w].card)) { w = i; }
  }
  return trick[w].pi;
}
// blackJokerPlayed: true once JOKER_B has been played in ANY trick this round (unlocks red joker for the rest of the game)
// blackJokerInTrick: true when JOKER_B is already in the current trick (also unlocks red joker mid-trick)
// Red joker rule: can be played once black joker has been seen, either earlier in the game OR in the same trick.
// When played legally, red joker beats every card on the table (power 21 > all).
function validCards(hand: CardStr[], ledSuit: string | null, blackJokerPlayed: boolean, blackJokerInTrick = false): CardStr[] {
  const redUnlocked = blackJokerPlayed || blackJokerInTrick;
  if (!ledSuit) {
    // Leading the trick — NEITHER joker may open a trick.
    const noJokers = hand.filter((c) => c !== JOKER_R && c !== JOKER_B);
    return noJokers.length > 0 ? noJokers : hand; // fallback: only jokers in hand
  }
  // Following: must follow led suit if possible.
  // JOKER_B is always playable when following, regardless of what suit was led.
  // JOKER_R is playable once black joker has been seen anywhere (this trick or a previous one).
  const same = hand.filter((c) => cardSuit(c) === ledSuit);
  const hasJokerB = hand.includes(JOKER_B);
  const hasJokerR = hand.includes(JOKER_R);
  if (same.length > 0) {
    const extras: CardStr[] = [];
    if (hasJokerB) extras.push(JOKER_B);
    if (hasJokerR && redUnlocked) extras.push(JOKER_R);
    return [...same, ...extras];
  }
  // No led-suit cards: anything goes EXCEPT red joker if black joker has never been seen
  if (hasJokerR && !redUnlocked) {
    return hand.filter((c) => c !== JOKER_R);
  }
  return hand;
}

// ─── Card display ─────────────────────────────────────────────

// SVG suit shapes — real playing card designs
function SuitSvg({ suit, size = 16, color }: { suit: string; size?: number; color?: string }) {
  const fill = color ?? (suit === "♦" ? "var(--cb-diamond,#dc2626)" : suit === "♥" ? "#dc2626" : "#111827");
  if (suit === "♥")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
        <path d="M12 21.593c-5.63-5.539-11-10.297-11-14.402C1 3.4 4.068 2 6.281 2c1.312 0 4.151.501 5.719 4.457C13.59 2.469 16.464 2 17.726 2 20.266 2 23 3.621 23 7.181c0 4.069-5.136 8.625-11 14.412z" />
      </svg>
    );
  if (suit === "♦")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
        <path d="M12 2L22 12 12 22 2 12z" />
      </svg>
    );
  if (suit === "♣")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
        <path d="M17.5 11A4.5 4.5 0 0 0 13.1 6C13.6 4.4 14.8 3 16 2h-8c1.2 1 2.4 2.4 2.9 4A4.5 4.5 0 0 0 6.5 15c1.1 0 2-.4 2.8-1C9 15.2 9 16.5 8 18h8c-1-1.5-1-2.8-.7-4 .8.6 1.7 1 2.7 1A4.5 4.5 0 0 0 17.5 11z" />
      </svg>
    );
  // ♠ spade
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
      <path d="M12 2C12 2 3 9 3 14.5A4.5 4.5 0 0 0 10.5 19c-.3 1-.8 1.8-1.5 2.5h6c-.7-.7-1.2-1.5-1.5-2.5A4.5 4.5 0 0 0 21 14.5C21 9 12 2 12 2z" />
    </svg>
  );
}


// Shared card face renderer (used by hand, trick area, and purchase preview)
function PlayingCard({
  card,
  active = false,
  dim = false,
  onClick,
  size = "md",
}: {
  card: CardStr;
  active?: boolean;
  dim?: boolean;
  onClick?: () => void;
  size?: "sm" | "md" | "lg";
}) {
  const W = size === "lg" ? "w-16 h-[100px]" : size === "sm" ? "w-10 h-[60px]" : "w-14 h-[88px]";
  const rankSz = size === "lg" ? "text-xl" : size === "sm" ? "text-[11px]" : "text-[15px]";
  const suitCornerSz = size === "lg" ? "text-sm" : size === "sm" ? "text-[9px]" : "text-[11px]";
  const suitCenterSz = size === "lg" ? 44 : size === "sm" ? 22 : 34;
  const pad = size === "sm" ? "p-0.5" : "p-1.5";

  // ── Shared jester SVG (B&W for black joker, colored for red joker) ──
  const JesterSVG = ({ bw }: { bw: boolean }) => (
    <svg viewBox="0 0 60 72" style={{ width: size === 'lg' ? 46 : size === 'sm' ? 28 : 38, height: 'auto' }} xmlns="http://www.w3.org/2000/svg">
      {/* Jester hat - left / right sides */}
      <path d="M18 34 Q14 20 10 8 Q16 14 20 12 Q22 6 25 2 Q28 6 30 14" fill={bw ? "#111" : "#7c3aed"} />
      <path d="M30 14 Q32 6 35 2 Q38 6 40 12 Q44 14 50 8 Q46 20 42 34" fill={bw ? "#333" : "#059669"} />
      {/* Hat brim */}
      <ellipse cx="30" cy="34" rx="14" ry="4" fill={bw ? "#000" : "#374151"} />
      {/* Hat bells */}
      <circle cx="10" cy="8" r="4" fill={bw ? "#111" : "#fbbf24"} stroke={bw ? "#000" : "#92400e"} strokeWidth={bw ? 1 : 0} />
      <circle cx="10" cy="8" r="1.5" fill={bw ? "#555" : "#92400e"} />
      <circle cx="50" cy="8" r="4" fill={bw ? "#111" : "#fbbf24"} stroke={bw ? "#000" : "#92400e"} strokeWidth={bw ? 1 : 0} />
      <circle cx="50" cy="8" r="1.5" fill={bw ? "#555" : "#92400e"} />
      <circle cx="30" cy="2" r="4" fill={bw ? "#111" : "#fbbf24"} stroke={bw ? "#000" : "#92400e"} strokeWidth={bw ? 1 : 0} />
      <circle cx="30" cy="2" r="1.5" fill={bw ? "#555" : "#92400e"} />
      {/* Face */}
      <ellipse cx="30" cy="48" rx="13" ry="14" fill={bw ? "#fff" : "#fef3c7"} stroke={bw ? "#111" : "none"} strokeWidth={bw ? 1 : 0} />
      {/* Eyes */}
      <ellipse cx="25" cy="45" rx="2.5" ry="3" fill="#111" />
      <ellipse cx="35" cy="45" rx="2.5" ry="3" fill="#111" />
      <circle cx="25.8" cy="44.2" r="1" fill="white" />
      <circle cx="35.8" cy="44.2" r="1" fill="white" />
      {/* Smile */}
      <path d="M22 53 Q30 60 38 53" stroke="#111" strokeWidth="2" fill="none" strokeLinecap="round" />
      {/* Cheeks */}
      <circle cx="21" cy="51" r="3" fill={bw ? "#bbb" : "#f87171"} opacity="0.4" />
      <circle cx="39" cy="51" r="3" fill={bw ? "#bbb" : "#f87171"} opacity="0.4" />
      {/* Nose */}
      <circle cx="30" cy="50" r="2" fill={bw ? "#333" : "#f97316"} />
      {/* Collar */}
      <path d="M17 60 Q20 56 24 58 Q27 55 30 57 Q33 55 36 58 Q40 56 43 60 Q38 65 30 65 Q22 65 17 60Z" fill={bw ? "#111" : "#7c3aed"} />
      <path d="M20 58 Q23 62 26 59 Q29 63 30 57 Q31 63 34 59 Q37 62 40 58" stroke={bw ? "#444" : "#a78bfa"} strokeWidth="0.8" fill="none" />
    </svg>
  );

  // Black Joker — white card, black jester
  if (card === JOKER_B) {
    return (
      <div onClick={onClick}
        className={`${W} ${pad} rounded-xl border-2 relative flex flex-col select-none flex-shrink-0 transition-all duration-150 overflow-hidden
          ${onClick ? (dim ? "cursor-not-allowed" : "cursor-pointer") : "cursor-default"}
          ${active ? "-translate-y-2 shadow-yellow-400/60 shadow-lg" : ""}`}
        style={{ backgroundColor: '#ffffff', borderColor: active ? '#facc15' : '#e5e7eb', boxShadow: active ? undefined : "0 2px 8px rgba(0,0,0,0.25)" }}>
        {dim && <div className="absolute inset-0 rounded-xl bg-gray-900/15 pointer-events-none z-10" />}
        {/* Corner labels */}
        <div className="flex justify-between px-0.5 pt-0.5 flex-shrink-0">
          <span className={`${rankSz} font-black leading-none`} style={{ color: '#111' }}>J</span>
          <span className={`${rankSz} font-black leading-none rotate-180`} style={{ color: '#111' }}>J</span>
        </div>
        {/* Black jester */}
        <div className="flex-1 flex flex-col items-center justify-center gap-0">
          <JesterSVG bw={true} />
          <div className={`font-black tracking-widest leading-none mt-0.5 ${size === 'sm' ? 'text-[6px]' : size === 'lg' ? 'text-[9px]' : 'text-[7px]'}`}
            style={{ color: '#111', letterSpacing: '0.15em' }}>JOKER</div>
        </div>
      </div>
    );
  }

  // Red Joker — white card, colored jester
  if (card === JOKER_R) {
    return (
      <div onClick={onClick}
        className={`${W} ${pad} rounded-xl border-2 relative flex flex-col select-none flex-shrink-0 transition-all duration-150 overflow-hidden
          ${onClick ? (dim ? "cursor-not-allowed" : "cursor-pointer") : "cursor-default"}
          ${active ? "-translate-y-2 shadow-yellow-400/60 shadow-lg" : ""}`}
        style={{ backgroundColor: '#ffffff', borderColor: active ? '#facc15' : '#e5e7eb', boxShadow: active ? undefined : "0 2px 8px rgba(0,0,0,0.18)" }}>
        {dim && <div className="absolute inset-0 rounded-xl bg-gray-900/15 pointer-events-none z-10" />}
        {/* Corner labels */}
        <div className="flex justify-between px-0.5 pt-0.5 flex-shrink-0">
          <span className={`${rankSz} font-black leading-none`} style={{ color: '#dc2626' }}>J</span>
          <span className={`${rankSz} font-black leading-none rotate-180`} style={{ color: '#dc2626' }}>J</span>
        </div>
        {/* Colored jester */}
        <div className="flex-1 flex flex-col items-center justify-center gap-0">
          <JesterSVG bw={false} />
          <div className={`font-black tracking-widest leading-none mt-0.5 ${size === 'sm' ? 'text-[6px]' : size === 'lg' ? 'text-[9px]' : 'text-[7px]'}`}
            style={{ color: '#7c3aed', letterSpacing: '0.15em' }}>JOKER</div>
        </div>
      </div>
    );
  }

  const suit = card.slice(-1);
  const value = card.slice(0, -1);
  const isRed = suit === "♥" || suit === "♦";
  const color = suit === "♦" ? "var(--cb-diamond,#dc2626)" : isRed ? "#dc2626" : "#111827";

  return (
    <div onClick={onClick}
      className={`${W} ${pad} rounded-xl border-2 relative flex flex-col justify-between select-none flex-shrink-0 transition-all duration-150
        ${onClick ? (dim ? "cursor-not-allowed" : "cursor-pointer hover:-translate-y-2 hover:shadow-xl") : "cursor-default"}
        ${active ? "-translate-y-2 shadow-yellow-400/60 shadow-lg" : ""}`}
      style={{ backgroundColor: '#ffffff', borderColor: active ? '#facc15' : '#e5e7eb', color, boxShadow: active ? undefined : "0 2px 8px rgba(0,0,0,0.25)" }}>
      {dim && <div className="absolute inset-0 rounded-xl bg-gray-900/15 pointer-events-none z-10" />}
      {/* Top-left corner */}
      <div className={`flex flex-col items-start leading-none ${dim ? "opacity-35" : ""}`}>
        <span className={`${rankSz} font-black leading-none`}>{value}</span>
        <span className={`${suitCornerSz} font-bold leading-none`}>{suit}</span>
      </div>
      {/* Center: large suit */}
      <div className={`flex-1 flex items-center justify-center ${dim ? "opacity-35" : ""}`}>
        <span className="font-black leading-none select-none" style={{ fontSize: suitCenterSz, color }}>{suit}</span>
      </div>
      {/* Bottom-right corner (rotated) */}
      <div className={`flex flex-col items-end leading-none rotate-180 ${dim ? "opacity-35" : ""}`}>
        <span className={`${rankSz} font-black leading-none`}>{value}</span>
        <span className={`${suitCornerSz} font-bold leading-none`}>{suit}</span>
      </div>
    </div>
  );
}

// ─── Misc components ──────────────────────────────────────────
const SUIT_COLORS: Record<string, string> = { "♥": "text-red-400", "♦": "text-red-400", "♠": "text-foreground", "♣": "text-foreground" };
const SUITS_UI = ["♠", "♥", "♦", "♣"];

const floatPositions = [
  { suit: "♠", delay: 0, left: 5, top: 10 }, { suit: "♥", delay: 2, left: 85, top: 20 },
  { suit: "♦", delay: 4, left: 15, top: 70 }, { suit: "♣", delay: 1, left: 75, top: 75 },
  { suit: "♥", delay: 3, left: 45, top: 5 }, { suit: "♠", delay: 5, left: 92, top: 55 },
];

function FloatingCard({ suit, delay, left, top }: { suit: string; delay: number; left: number; top: number }) {
  return (
    <div className="absolute text-4xl opacity-10 select-none pointer-events-none"
      style={{ WebkitAnimation: `floatCard 8s ease-in-out ${delay}s infinite`, animation: `floatCard 8s ease-in-out ${delay}s infinite`, left: `${left}%`, top: `${top}%` }}>
      <span className={SUIT_COLORS[suit]}>{suit}</span>
    </div>
  );
}

function ScoreBar({ score, maxScore, label, color }: { score: number; maxScore: number; label: string; color: string }) {
  const pct = Math.max(0, Math.min(100, (score / maxScore) * 100));
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center text-sm">
        <span className="text-muted-foreground font-medium">{label}</span>
        <span className="font-bold text-foreground">{score}</span>
      </div>
      <div className="h-3 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

interface ChatMsg { sender: string; text: string; time: string; }

// ─── Offline (no-internet) local socket ───────────────────────
// Acts like a Socket.io socket but never touches the network.
// The host handles all game logic client-side already; this just
// satisfies the optional-chain calls and fires "connect" so the UI
// shows a connected state.
function createOfflineSocket() {
  const handlers = new Map<string, Array<(...a: any[]) => void>>();
  const trigger = (ev: string, ...args: any[]) => {
    (handlers.get(ev) ?? []).forEach(h => setTimeout(() => h(...args), 0));
  };
  const sock: any = {
    id: `offline-${Math.random().toString(36).slice(2)}`,
    connected: true,
    on(ev: string, fn: (...a: any[]) => void) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev)!.push(fn);
      return sock;
    },
    off(ev: string, fn?: (...a: any[]) => void) {
      if (!fn) handlers.delete(ev);
      else handlers.set(ev, (handlers.get(ev) ?? []).filter(h => h !== fn));
      return sock;
    },
    emit(ev: string, _data?: any) {
      return sock;
    },
    disconnect() { sock.connected = false; },
    _trigger: trigger,
  };
  setTimeout(() => trigger("connect"), 0);
  return sock;
}

// ─── Fireworks / Confetti celebration canvas ──────────────────
function CelebrationCanvas({ winner }: { winner: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const _c = canvasRef.current;
    if (!_c) return;
    const canvas: HTMLCanvasElement = _c;
    const ctx = canvas.getContext("2d")!;
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    const isT1 = winner === "العربي";
    const TEAM_COLOR = isT1 ? "#ef4444" : "#38bdf8";
    const TEAM_LIGHT = isT1 ? "#fca5a5" : "#7dd3fc";
    const COLORS = [TEAM_COLOR, TEAM_LIGHT, "#fbbf24", "#a78bfa", "#ffffff", "#34d399", "#f9a8d4"];

    // ── Particle types ──────────────────────────────────────────
    interface Particle {
      x: number; y: number; vx: number; vy: number;
      color: string; alpha: number; size: number;
      rot: number; rotV: number; type: "rect" | "circle" | "star";
      gravity: number; drag: number;
    }

    const particles: Particle[] = [];

    function randColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }
    function rand(min: number, max: number) { return min + Math.random() * (max - min); }

    // Burst from a point — firework explosion
    function burst(cx: number, cy: number, count = 60, palette?: string[]) {
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + rand(-0.3, 0.3);
        const speed = rand(2, 9);
        const color = palette ? palette[Math.floor(Math.random() * palette.length)] : randColor();
        particles.push({
          x: cx, y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          color, alpha: 1,
          size: rand(2.5, 5.5),
          rot: rand(0, Math.PI * 2),
          rotV: rand(-0.15, 0.15),
          type: Math.random() < 0.4 ? "rect" : Math.random() < 0.5 ? "star" : "circle",
          gravity: rand(0.04, 0.12),
          drag: rand(0.96, 0.99),
        });
      }
    }

    // Confetti rain from top
    function spawnConfetti(n = 15) {
      for (let i = 0; i < n; i++) {
        particles.push({
          x: rand(0, canvas.width),
          y: rand(-20, -5),
          vx: rand(-1.5, 1.5),
          vy: rand(2, 5),
          color: randColor(),
          alpha: 1,
          size: rand(5, 10),
          rot: rand(0, Math.PI * 2),
          rotV: rand(-0.12, 0.12),
          type: "rect",
          gravity: 0.06,
          drag: 0.99,
        });
      }
    }

    // Scheduled firework launches
    const W = canvas.width, H = canvas.height;
    const launches: { delay: number; x: number; y: number; fired?: boolean }[] = [];
    const totalDuration = 5500;
    const teamPal = [TEAM_COLOR, TEAM_LIGHT, "#fbbf24"];
    for (let i = 0; i < 22; i++) {
      launches.push({
        delay: i * 230 + rand(0, 120),
        x: rand(W * 0.1, W * 0.9),
        y: rand(H * 0.08, H * 0.55),
      });
    }

    const start = performance.now();
    let confettiTimer = 0;

    function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
      const spikes = 5;
      const step = Math.PI / spikes;
      ctx.beginPath();
      for (let i = 0; i < spikes * 2; i++) {
        const radius = i % 2 === 0 ? r : r * 0.45;
        const a = i * step - Math.PI / 2;
        if (i === 0) ctx.moveTo(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
        else ctx.lineTo(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
      }
      ctx.closePath();
    }

    function frame(now: number) {
      const elapsed = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Fire scheduled bursts
      for (const l of launches) {
        if (!l.fired && elapsed >= l.delay) {
          l.fired = true;
          burst(l.x, l.y, Math.floor(rand(50, 80)), teamPal);
        }
      }

      // Confetti rain
      confettiTimer += 16;
      if (confettiTimer > 120 && elapsed < totalDuration - 1000) {
        confettiTimer = 0;
        spawnConfetti(12);
      }

      // Update & draw particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy;
        p.vy += p.gravity;
        p.vx *= p.drag; p.vy *= p.drag;
        p.rot += p.rotV;
        p.alpha -= 0.008 + (elapsed / totalDuration) * 0.012;
        if (p.alpha <= 0 || p.y > canvas.height + 20) { particles.splice(i, 1); continue; }
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.fillStyle = p.color;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        if (p.type === "rect") {
          ctx.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6);
        } else if (p.type === "star") {
          drawStar(ctx, 0, 0, p.size);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size * 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      if (elapsed < totalDuration || particles.length > 0) {
        rafRef.current = requestAnimationFrame(frame);
      }
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
  }, [winner]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 9999 }}
    />
  );
}

// ─── Main component ───────────────────────────────────────────
export default function Game() {
  const { toast } = useToast();
  const socketRef = useRef<Socket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // Lobby voice chat refs
  const lobbyPcRef = useRef<RTCPeerConnection | null>(null);
  const lobbyStreamRef = useRef<MediaStream | null>(null);
  const lobbyAudioElRef = useRef<HTMLAudioElement | null>(null);

  // Phases
  const [phase, setPhase] = useState<"setup" | "rooms" | "game">("setup");
  const [showRules, setShowRules] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [roundPhase, setRoundPhase] = useState<"dealing" | "purchasing">("dealing");

  // Setup
  const [playerName, setPlayerName] = useState(() => {
    try { return localStorage.getItem("speet-name") || ""; } catch { return ""; }
  });
  const [playerCount, setPlayerCount] = useState<4 | 6>(4);
  const [isGuestMode, setIsGuestMode] = useState(false);

  // Admin
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminPassInput, setAdminPassInput] = useState("");
  const [adminAuthFailed, setAdminAuthFailed] = useState(false);
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [showAdminOverlay, setShowAdminOverlay] = useState(false);
  const [adminState, setAdminState] = useState<any>(null);
  const [adminLogEntries, setAdminLogEntries] = useState<any[]>([]);
  const [adminAnnounceInput, setAdminAnnounceInput] = useState("");
  const [myIndex, setMyIndex] = useState(() => {
    try { const s = localStorage.getItem("speet-last-seat"); return s !== null ? Math.max(0, Math.min(5, parseInt(s, 10))) : 0; }
    catch { return 0; }
  });
  const [isHost, setIsHost] = useState(false);
  const [offlineMode, setOfflineMode] = useState(false);
  const [offlinePc, setOfflinePc] = useState<4 | 6>(4);
  const [quickPc, setQuickPc] = useState<4 | 6>(4);
  const [quickMatchLoading, setQuickMatchLoading] = useState(false);
  const [refreshingRooms, setRefreshingRooms] = useState(false);

  // Lobby hall (pre-game)
  const [lobbyPlayers, setLobbyPlayers] = useState<{socketId: string; name: string}[]>([]);
  const [lobbyMessages, setLobbyMessages] = useState<{name: string; text: string; ts: number}[]>([]);
  const [lobbyChatInput, setLobbyChatInput] = useState("");
  const [lobbyChatOpen, setLobbyChatOpen] = useState(false);
  const [incomingInvite, setIncomingInvite] = useState<{roomId: string; roomName: string; playerCount: number; inviterName: string} | null>(null);
  const lobbyMsgEndRef = useRef<HTMLDivElement>(null);

  // Rooms lobby
  const roomIdRef = useRef("hokm-main");
  const [roomId, setRoomId] = useState("hokm-main");
  const [activeRooms, setActiveRooms] = useState<{ id: string; name: string; playerCount: number; players: number; status: string; createdAt: number; seats?: Record<number, string>; botSeats?: number[] }[]>([]);
  const [startMode, setStartMode] = useState<"wait" | "immediate">("wait");
  const startModeRef = useRef<"wait" | "immediate">("wait");

  // Cards
  const [myHand, setMyHand] = useState<CardStr[]>([]);

  // Players
  const [players, setPlayers] = useState<{ name: string }[]>([]);

  // Purchases
  const [submittedPurchases, setSubmittedPurchases] = useState<(number | null)[]>([]);
  const [myDraft, setMyDraft] = useState(0);
  const [mySubmitted, setMySubmitted] = useState(false);
  const [purchaseOrder, setPurchaseOrder] = useState<number[]>([]);
  const [hostDraftBid, setHostDraftBid] = useState(0);

  // Buy-rotation tracking
  const [lastBuyRound, setLastBuyRound] = useState<[number, number]>([0, 0]);
  const [forcedBuyTeam, setForcedBuyTeam] = useState<0 | 1 | null>(null);
  // Per-player buy tracking (4-player: each must buy once per game)
  const [playerLastBoughtRound, setPlayerLastBoughtRound] = useState<number[]>([0, 0, 0, 0, 0, 0]);
  const [forcedBuyPlayer, setForcedBuyPlayer] = useState<number | null>(null);

  // Scores
  const [team1Score, setTeam1Score] = useState(0);
  const [team2Score, setTeam2Score] = useState(0);
  const [roundNumber, setRoundNumber] = useState(0);
  const [roundLog, setRoundLog] = useState<string[]>([]);
  const [gameOver, setGameOver] = useState(false);
  const [winner, setWinner] = useState("");
  const [showCelebration, setShowCelebration] = useState(false);
  const [nextRoundCountdown, setNextRoundCountdown] = useState<number | null>(null);
  const [lastRoundSummary, setLastRoundSummary] = useState<string | null>(null);
  const [lastRoundPlayerStats, setLastRoundPlayerStats] = useState<{ name: string; bid: number; actual: number; team: number }[] | null>(null);
  const [inGameSession, setInGameSession] = useState(false);

  // Connection
  const [connected, setConnected] = useState(false);
  const [onlinePlayers, setOnlinePlayers] = useState(0);
  const [micOn, setMicOn] = useState(false);
  const [lobbyMicOn, setLobbyMicOn] = useState(false);
  const [lobbyAudioMuted, setLobbyAudioMuted] = useState(false);
  const [lobbyVoiceUsers, setLobbyVoiceUsers] = useState<string[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(() => {
    try { return localStorage.getItem("speet-sound") !== "false"; } catch { return true; }
  });
  const soundEnabledRef = useRef(soundEnabled);
  useEffect(() => { soundEnabledRef.current = soundEnabled; localStorage.setItem("speet-sound", soundEnabled ? "true" : "false"); }, [soundEnabled]);

  // Settings panel
  const [showSettings, setShowSettings] = useState(false);
  const [vibrationEnabled, setVibrationEnabled] = useState(() => {
    try { return localStorage.getItem("speet-vibration") !== "false"; } catch { return true; }
  });
  const vibrationEnabledRef = useRef(true);
  useEffect(() => { vibrationEnabledRef.current = vibrationEnabled; localStorage.setItem("speet-vibration", vibrationEnabled ? "true" : "false"); }, [vibrationEnabled]);
  const [autoHint, setAutoHint] = useState(() => {
    try { return localStorage.getItem("speet-autohint") === "true"; } catch { return false; }
  });
  useEffect(() => { localStorage.setItem("speet-autohint", autoHint ? "true" : "false"); }, [autoHint]);
  const [cardSizePref, setCardSizePref] = useState<"sm" | "md" | "lg">(() => {
    try { return (localStorage.getItem("speet-cardsize") as "sm" | "md" | "lg") || "md"; } catch { return "md"; }
  });
  useEffect(() => { localStorage.setItem("speet-cardsize", cardSizePref); }, [cardSizePref]);

  const [playerIcon, setPlayerIcon] = useState(() => {
    try { return localStorage.getItem("speet-icon") || "♠"; } catch { return "♠"; }
  });
  useEffect(() => { localStorage.setItem("speet-icon", playerIcon); }, [playerIcon]);

  const [animSpeed, setAnimSpeed] = useState<"fast" | "normal" | "slow">(() => {
    try { return (localStorage.getItem("speet-animspeed") as any) || "normal"; } catch { return "normal"; }
  });
  useEffect(() => { localStorage.setItem("speet-animspeed", animSpeed); }, [animSpeed]);
  const animDurationMs = animSpeed === "fast" ? 100 : animSpeed === "slow" ? 600 : 300;

  const [colorBlindMode, setColorBlindMode] = useState(() => {
    try { return localStorage.getItem("speet-colorblind") === "true"; } catch { return false; }
  });
  useEffect(() => {
    localStorage.setItem("speet-colorblind", colorBlindMode ? "true" : "false");
    if (colorBlindMode) document.documentElement.classList.add("cb");
    else document.documentElement.classList.remove("cb");
  }, [colorBlindMode]);

  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState<any>(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [quickJoinRoomId, setQuickJoinRoomId] = useState<string | null>(null);
  const quickJoinDoneRef = useRef(false);
  const [nameShake, setNameShake] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  // Theme preference (dark / light)
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try { return (localStorage.getItem("speet-theme") as "dark" | "light") || "light"; } catch { return "light"; }
  });
  useEffect(() => {
    localStorage.setItem("speet-theme", theme);
    const root = document.documentElement;
    if (theme === "light") {
      root.classList.remove("dark");
      root.classList.add("light");
    } else {
      root.classList.remove("light");
      root.classList.add("dark");
    }
  }, [theme]);

  // Trick winner banner
  const [trickWinnerBanner, setTrickWinnerBanner] = useState<number | null>(null);
  const trickWinnerBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Emoji reactions
  const [emojiReactions, setEmojiReactions] = useState<{ id: number; name: string; emoji: string; x: number }[]>([]);
  const emojiIdRef = useRef(0);

  // Purchase summary (briefly shown when all bids submitted)
  const [purchaseSummaryVisible, setPurchaseSummaryVisible] = useState(false);
  const [purchaseCountdown, setPurchaseCountdown] = useState<number | null>(null);
  const [lawrenceAlert, setLawrenceAlert] = useState<{ playerName: string; team: number } | null>(null);
  const lawrenceAlertRef = useRef<{ playerName: string; team: number } | null>(null);

  // ── Feature: sweep bonus celebration ──────────────────────────
  const [sweepBannerTeam, setSweepBannerTeam] = useState<0 | 1 | null>(null);
  const sweepBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Feature: game-wide stats tracking ────────────────────────
  // Cumulative across all rounds of the current game
  const [gameStats, setGameStats] = useState<{
    tricksPerPlayer: number[];
    trumpPerPlayer: number[];
  }>({ tricksPerPlayer: [], trumpPerPlayer: [] });
  // Tracks trump card plays by player in the current round
  const trumpPlaysThisRoundRef = useRef<number[]>([]);

  // ── Feature: failed bid penalty banner ───────────────────────
  const [failBidBanner, setFailBidBanner] = useState<{
    teamLabel: string;
    bid: number;
    got: number;
    penalty: number;
  } | null>(null);
  const failBidBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Chat
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const [windowWidth, setWindowWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 1024);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const isMobile = windowWidth < 640;

  // Spectator mode
  const [isSpectator, setIsSpectator] = useState(false);
  const isSpectatorRef = useRef(false);
  const [spectators, setSpectators] = useState<{ name: string; socketId: string }[]>([]);
  const [spectatorJoinName, setSpectatorJoinName] = useState<string | null>(null);
  const prevSpectatorIdsRef = useRef<Set<string>>(new Set());

  // Bots
  const [claimedSeats, setClaimedSeats] = useState<Record<number, string>>({});
  const [botSeats, setBotSeats] = useState<Set<number>>(new Set());
  const [botCountdown, setBotCountdown] = useState<number | null>(null);

  // Player online status (seatIndex → offline)
  const [offlineSeats, setOfflineSeats] = useState<Set<number>>(new Set());
  const offlineSeatsRef = useRef<Set<number>>(new Set());

  // Hand display: "suit" = group by suit (default), "rank" = group by rank
  const [handSortMode, setHandSortMode] = useState<"suit" | "rank">("suit");
  const [originalHand, setOriginalHand] = useState<CardStr[]>([]);

  // Round history panel toggle in game over screen
  const [showRoundHistory, setShowRoundHistory] = useState(false);

  // Purchase timer
  const [purchaseTimer, setPurchaseTimer] = useState<number | null>(null);

  // Bid flash notification — shown when another player submits their bid
  const [bidFlash, setBidFlash] = useState<{ name: string; value: number; team: number; isTeammate: boolean } | null>(null);
  const bidFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Sound effects (Web Audio API — no external files) ────────
  const audioCtxRef = useRef<AudioContext | null>(null);
  function getAudioCtx() {
    if (!audioCtxRef.current) {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return null;
      audioCtxRef.current = new AC();
    }
    // iOS Safari: resume suspended context (requires prior user gesture)
    if (audioCtxRef.current?.state === "suspended") {
      audioCtxRef.current?.resume().catch(() => {});
    }
    return audioCtxRef.current;
  }
  // Unlock AudioContext on first user interaction (iOS Safari requirement)
  useEffect(() => {
    const unlock = () => {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AC();
      }
      if (audioCtxRef.current?.state === "suspended") {
        audioCtxRef.current?.resume().catch(() => {});
      }
    };
    window.addEventListener("touchstart", unlock, { once: true, passive: true });
    window.addEventListener("touchend", unlock, { once: true, passive: true });
    window.addEventListener("click", unlock, { once: true });
    return () => {
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("touchend", unlock);
      window.removeEventListener("click", unlock);
    };
  }, []);
  /** Short card-slap sound when any card is played */
  function playCardSound() {
    if (!soundEnabledRef.current) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      // White noise burst
      const bufLen = ctx.sampleRate * 0.08;
      const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufLen);
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      // Low-pass filter gives the "thwack" body
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 1200;
      // Short gain envelope
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.55, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      noise.connect(lp); lp.connect(gain); gain.connect(ctx.destination);
      noise.start(); noise.stop(ctx.currentTime + 0.08);
      // Add a subtle low "click" tone
      const osc = ctx.createOscillator();
      osc.type = "sine"; osc.frequency.value = 140;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.3, ctx.currentTime);
      g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
      osc.connect(g2); g2.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.06);
    } catch { /* ignore if audio not allowed */ }
  }
  /** Distinct two-note chime when it becomes MY turn */
  function playMyTurnSound() {
    if (!soundEnabledRef.current) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const o1 = ctx.createOscillator(); o1.type = "sine"; o1.frequency.value = 880;
      const g1 = ctx.createGain();
      g1.gain.setValueAtTime(0, ctx.currentTime);
      g1.gain.linearRampToValueAtTime(0.4, ctx.currentTime + 0.02);
      g1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
      o1.connect(g1); g1.connect(ctx.destination);
      o1.start(ctx.currentTime); o1.stop(ctx.currentTime + 0.28);
      const o2 = ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = 1318;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0, ctx.currentTime + 0.15);
      g2.gain.linearRampToValueAtTime(0.35, ctx.currentTime + 0.17);
      g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      o2.connect(g2); g2.connect(ctx.destination);
      o2.start(ctx.currentTime + 0.15); o2.stop(ctx.currentTime + 0.5);
    } catch { /* ignore */ }
  }
  /** Triumphant ascending chord when MY TEAM wins a trick */
  function playTrickWinSound() {
    if (!soundEnabledRef.current) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const notes = [523, 659, 784]; // C5, E5, G5
      notes.forEach((freq, i) => {
        const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = freq;
        const g = ctx.createGain();
        const t0 = ctx.currentTime + i * 0.08;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.22, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 0.3);
      });
    } catch { /* ignore */ }
  }
  /** Low descending notes when OPPONENT wins a trick */
  function playTrickLoseSound() {
    if (!soundEnabledRef.current) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const notes = [330, 262]; // E4, C4
      notes.forEach((freq, i) => {
        const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = freq;
        const g = ctx.createGain();
        const t0 = ctx.currentTime + i * 0.12;
        g.gain.setValueAtTime(0.18, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 0.35);
      });
    } catch { /* ignore */ }
  }
  /** Fanfare when winning the game */
  function playGameWinSound() {
    if (!soundEnabledRef.current) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const melody = [523, 659, 784, 1047, 784, 1047]; // C5 E5 G5 C6 G5 C6
      const times  = [0, 0.12, 0.24, 0.38, 0.52, 0.62];
      melody.forEach((freq, i) => {
        const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = freq;
        const g = ctx.createGain();
        const t0 = ctx.currentTime + times[i];
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.35, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.28);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 0.28);
      });
    } catch { /* ignore */ }
  }
  /** Sad descending when losing the game */
  function playGameLoseSound() {
    if (!soundEnabledRef.current) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const notes = [494, 440, 392, 330]; // B4, A4, G4, E4
      const times  = [0, 0.18, 0.36, 0.54];
      notes.forEach((freq, i) => {
        const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = freq;
        const g = ctx.createGain();
        const t0 = ctx.currentTime + times[i];
        g.gain.setValueAtTime(0.28, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 0.4);
      });
    } catch { /* ignore */ }
  }
  /** Police siren + shout "لورنس" when someone bids Lawrence during purchase */
  function playLawrenceSiren() {
    if (!soundEnabledRef.current) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const duration = 3.2;
      const cycles = 4;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sawtooth";
      osc.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0.0, now);
      gain.gain.linearRampToValueAtTime(0.22, now + 0.05);
      gain.gain.setValueAtTime(0.22, now + duration - 0.1);
      gain.gain.linearRampToValueAtTime(0.0, now + duration);
      for (let i = 0; i < cycles; i++) {
        const t = now + (i * duration) / cycles;
        const half = duration / cycles / 2;
        osc.frequency.setValueAtTime(600, t);
        osc.frequency.linearRampToValueAtTime(1050, t + half * 0.9);
        osc.frequency.setValueAtTime(1050, t + half);
        osc.frequency.linearRampToValueAtTime(600, t + half * 1.9);
      }
      osc.start(now);
      osc.stop(now + duration);
    } catch { /* ignore */ }
  }
  /** Generic Arabic speech synthesis */
  function speakArabic(text: string, rate = 0.85, pitch = 1.1) {
    try {
      if (!soundEnabledRef.current || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const voices = window.speechSynthesis.getVoices();
      const arabicVoice = voices.find(v => v.lang.startsWith("ar")) || null;
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = "ar-SA";
      utter.rate = rate;
      utter.pitch = pitch;
      utter.volume = 1.0;
      if (arabicVoice) utter.voice = arabicVoice;
      window.speechSynthesis.speak(utter);
    } catch { /* ignore */ }
  }
  /** Speech synthesis: shout "لوررنس لوررنس" in Arabic */
  function speakLawrence() {
    try {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const voices = window.speechSynthesis.getVoices();
      const arabicVoice = voices.find(v => v.lang.startsWith("ar")) || null;
      const utter = new SpeechSynthesisUtterance("لوررنس!  لوررنس لوررنس!");
      utter.lang = "ar-SA";
      utter.rate = 0.75;
      utter.pitch = 1.4;
      utter.volume = 1.0;
      if (arabicVoice) utter.voice = arabicVoice;
      window.speechSynthesis.speak(utter);
    } catch { /* ignore */ }
  }
  /** Dramatic 3-note Lawrence announcement */
  function playLawrenceSound() {
    if (!soundEnabledRef.current) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const notes = [523, 784, 1047]; // C5, G5, C6
      const times  = [0, 0.15, 0.32];
      notes.forEach((freq, i) => {
        const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = freq;
        const g = ctx.createGain();
        const t0 = ctx.currentTime + times[i];
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.25, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 0.35);
      });
    } catch { /* ignore */ }
  }
  /** Soft card-shuffle sound when cards are dealt */
  function playDealSound() {
    if (!soundEnabledRef.current) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      // Three rapid white-noise bursts simulating a shuffle
      [0, 0.09, 0.18].forEach((delay) => {
        const bufLen = Math.floor(ctx.sampleRate * 0.07);
        const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufLen) * 0.6;
        const src = ctx.createBufferSource(); src.buffer = buf;
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2000;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.4, ctx.currentTime + delay);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.07);
        src.connect(lp); lp.connect(g); g.connect(ctx.destination);
        src.start(ctx.currentTime + delay); src.stop(ctx.currentTime + delay + 0.07);
      });
    } catch { /* ignore */ }
  }
  /** Soft click + rising tone when submitting a bid */
  function playBidSound() {
    if (!soundEnabledRef.current) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const o = ctx.createOscillator(); o.type = "sine";
      o.frequency.setValueAtTime(440, ctx.currentTime);
      o.frequency.linearRampToValueAtTime(660, ctx.currentTime + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.18);
    } catch { /* ignore */ }
  }

  // Trick play
  const [playingPhase, setPlayingPhase] = useState(false);
  const [trickCards, setTrickCards] = useState<{ pi: number; card: CardStr }[]>([]);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [trickLeader, setTrickLeader] = useState(0);
  const [tricksWon, setTricksWon] = useState<number[]>([]);
  const [trickNumber, setTrickNumber] = useState(0);
  const [trickAnimating, setTrickAnimating] = useState(false);
  const [lastTrickWinner, setLastTrickWinner] = useState<number | null>(null);
  const [blackJokerPlayed, setBlackJokerPlayed] = useState(false);
  const [lastTrickForfeited, setLastTrickForfeited] = useState(false);
  const [playTimer, setPlayTimer] = useState<number | null>(null);
  const playTimerRef = useRef<number | null>(null);
  const [cardsJustDealt, setCardsJustDealt] = useState(false);
  const [dealRevealTimer, setDealRevealTimer] = useState(0);
  // Epoch incremented each time new hand is dealt → forces CSS animation restart
  const [dealEpoch, setDealEpoch] = useState(0);
  // True for the first 2 seconds of dealing to show the animated hand overlay
  const [showDealHand, setShowDealHand] = useState(false);
  // Score flash states: set briefly when team score changes
  const [scoreFlashT1, setScoreFlashT1] = useState(false);
  const [scoreFlashT2, setScoreFlashT2] = useState(false);
  const prevTeam1ScoreRef = useRef(0);
  const prevTeam2ScoreRef = useRef(0);

  // ── New features ────────────────────────────────────────────
  // Last tricks log (up to last 4)
  const [lastTricksLog, setLastTricksLog] = useState<{ winnerName: string; teamWon: number; trickNum: number }[]>([]);
  // Session statistics (persisted via localStorage)
  const [sessionStats, setSessionStats] = useState<{ wins: number; losses: number; tricks: number }>(() => {
    try { return JSON.parse(localStorage.getItem("speet-stats") ?? "null") ?? { wins: 0, losses: 0, tricks: 0 }; }
    catch { return { wins: 0, losses: 0, tricks: 0 }; }
  });
  // Bot difficulty
  const [botDifficulty, setBotDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const botDifficultyRef = useRef<"easy" | "medium" | "hard">("medium");
  useEffect(() => { botDifficultyRef.current = botDifficulty; }, [botDifficulty]);
  // Hint card (suggested card for the human player)
  const [hintCard, setHintCard] = useState<CardStr | null>(null);
  const [showHint, setShowHint] = useState(false);
  const [adminAnnouncement, setAdminAnnouncement] = useState<string | null>(null);
  // Table theme
  const [tableTheme, setTableTheme] = useState<"green" | "blue" | "purple" | "brown">(() => {
    try { return (localStorage.getItem("speet-tabletheme") as "green" | "blue" | "purple" | "brown") || "green"; } catch { return "green"; }
  });
  useEffect(() => { localStorage.setItem("speet-tabletheme", tableTheme); }, [tableTheme]);
  const [tableShape, setTableShape] = useState<"rect" | "oval">(() => {
    try { return (localStorage.getItem("speet-tableshape") as "rect" | "oval") || "rect"; } catch { return "rect"; }
  });
  useEffect(() => { localStorage.setItem("speet-tableshape", tableShape); }, [tableShape]);
  // Round timer
  const roundStartTimeRef = useRef<number | null>(null);
  const [roundDuration, setRoundDuration] = useState<number | null>(null);
  // Last trick overlay
  const [showLastTrickOverlay, setShowLastTrickOverlay] = useState(false);
  const [lastTrickCards, setLastTrickCards] = useState<{ pi: number; card: CardStr }[]>([]);
  // Manual card sort toggle
  const [isSorted, setIsSorted] = useState(true);
  const isSortedRef = useRef(true);
  useEffect(() => { isSortedRef.current = isSorted; }, [isSorted]);
  // Share copied feedback
  const [shareCopied, setShareCopied] = useState(false);

  const prevTotalsRef = useRef<number[]>([]);
  const maxScoreRef = useRef(54);
  const minRoundScoreRef = useRef(8);
  const playerCountRef = useRef(4);
  const botSeatsRef = useRef<Set<number>>(new Set());
  const claimedSeatsRef = useRef<Record<number, string>>({});
  const botHandsRef = useRef<Record<number, CardStr[]>>({});
  const botPlayedRef = useRef<Record<number, Set<CardStr>>>({});
  const allPlayedCardsRef = useRef<Set<CardStr>>(new Set());
  const pendingJoinRef = useRef<{ roomId: string; name: string } | null>(null);
  const blackJokerPlayedRef = useRef(false);
  // Snapshot of blackJokerPlayed taken BEFORE the current trick begins
  const blackJokerSeenBeforeTrickRef = useRef(false);
  const myDraftRef = useRef(0);
  const mySubmittedRef = useRef(false);
  // Trick refs (always fresh inside socket callbacks)
  const trickCardsRef = useRef<{ pi: number; card: CardStr }[]>([]);
  const currentTurnRef = useRef(0);
  const trickLeaderRef = useRef(0);
  const tricksWonRef = useRef<number[]>([]);
  const trickNumberRef = useRef(0);
  const totalTricksRef = useRef(13);
  const playingPhaseRef = useRef(false);
  const submittedPurchasesRef = useRef<(number | null)[]>([]);
  const team1ScoreRef = useRef(0);
  const team2ScoreRef = useRef(0);
  const roundNumberRef = useRef(0);
  const lastBuyRoundRef = useRef<[number, number]>([0, 0]);
  const forcedBuyTeamRef = useRef<0 | 1 | null>(null);
  const playerLastBoughtRoundRef = useRef<number[]>([0, 0, 0, 0, 0, 0]);
  const forcedBuyPlayerRef = useRef<number | null>(null);
  const purchaseTurnRef = useRef<number>(-1);
  const hostDraftBidRef = useRef<number>(0);
  const roundLogRef = useRef<string[]>([]);
  const playersRef = useRef<{ name: string }[]>([]);
  const myHandRef = useRef<CardStr[]>([]);
  // Callbacks stored in refs so socket closures always call the latest version
  const applyCardRef = useRef<(pi: number, card: CardStr) => void>(() => {});
  const computeResultRef = useRef<(tw: number[]) => void>(() => {});
  const handleNextRoundRef = useRef<() => void>(() => {});

  useEffect(() => { botSeatsRef.current = botSeats; }, [botSeats]);
  useEffect(() => { offlineSeatsRef.current = offlineSeats; }, [offlineSeats]);
  useEffect(() => { claimedSeatsRef.current = claimedSeats; }, [claimedSeats]);
  useEffect(() => { myDraftRef.current = myDraft; }, [myDraft]);
  useEffect(() => { mySubmittedRef.current = mySubmitted; }, [mySubmitted]);
  useEffect(() => { submittedPurchasesRef.current = submittedPurchases; }, [submittedPurchases]);
  useEffect(() => { team1ScoreRef.current = team1Score; }, [team1Score]);
  useEffect(() => { team2ScoreRef.current = team2Score; }, [team2Score]);
  // Score flash when team scores change
  useEffect(() => {
    if (team1Score !== prevTeam1ScoreRef.current && prevTeam1ScoreRef.current !== 0) {
      setScoreFlashT1(true);
      const t = setTimeout(() => setScoreFlashT1(false), 700);
      return () => clearTimeout(t);
    }
    prevTeam1ScoreRef.current = team1Score;
  }, [team1Score]);
  useEffect(() => {
    if (team2Score !== prevTeam2ScoreRef.current && prevTeam2ScoreRef.current !== 0) {
      setScoreFlashT2(true);
      const t = setTimeout(() => setScoreFlashT2(false), 700);
      return () => clearTimeout(t);
    }
    prevTeam2ScoreRef.current = team2Score;
  }, [team2Score]);
  useEffect(() => { roundNumberRef.current = roundNumber; }, [roundNumber]);
  useEffect(() => { roundLogRef.current = roundLog; }, [roundLog]);
  useEffect(() => { playersRef.current = players; }, [players]);
  useEffect(() => { myHandRef.current = myHand; }, [myHand]);
  useEffect(() => { playingPhaseRef.current = playingPhase; }, [playingPhase]);
  useEffect(() => { blackJokerPlayedRef.current = blackJokerPlayed; }, [blackJokerPlayed]);
  useEffect(() => { lastBuyRoundRef.current = lastBuyRound; }, [lastBuyRound]);

  // PWA install prompt
  useEffect(() => {
    const handler = (e: any) => { e.preventDefault(); setDeferredInstallPrompt(e); setShowInstallBanner(true); };
    window.addEventListener("beforeinstallprompt", handler as any);
    return () => window.removeEventListener("beforeinstallprompt", handler as any);
  }, []);

  // Read ?room= URL param on mount
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const r = params.get("room");
      if (r) setQuickJoinRoomId(r);
    } catch {}
  }, []);

  // Auto-join when rooms list arrives and quickJoinRoomId is set
  useEffect(() => {
    if (phase !== "rooms" || !quickJoinRoomId || quickJoinDoneRef.current || activeRooms.length === 0) return;
    const room = activeRooms.find(r => r.id === quickJoinRoomId);
    if (room) {
      quickJoinDoneRef.current = true;
      setQuickJoinRoomId(null);
      const pc = (room.playerCount === 6 ? 6 : 4) as 4 | 6;
      setPlayerCount(pc);
      setStartMode("wait");
      startModeRef.current = "wait";
      initGameState(pc, room.id);
      setPhase("game");
      setIsHost(false);
      isHostRef.current = false;
      const joinName = playerName.trim() || "لاعب";
      if (room.status !== "playing") {
        pendingJoinRef.current = { roomId: room.id, name: joinName };
      }
      socketRef.current?.emit("joinRoom", room.id, joinName);
    }
  }, [phase, activeRooms]);

  // ── Socket setup ──────────────────────────────────────────
  useEffect(() => {
    const socket = io(window.location.origin, { transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("playerJoined", (d: any) => setOnlinePlayers(d.playerCount));

    // ── Admin events ──────────────────────────────────────────
    socket.on("kicked", ({ reason }: { reason: string }) => {
      alert(reason || "تم طردك من اللعبة");
      window.location.reload();
    });
    socket.on("roomClosed", ({ reason }: { reason: string }) => {
      alert(reason || "تم إغلاق الغرفة");
      window.location.reload();
    });
    socket.on("serverAnnouncement", ({ message }: { message: string }) => {
      setAdminAnnouncement(message);
      setTimeout(() => setAdminAnnouncement(null), 8000);
    });
    socket.on("adminAuthOk", () => {
      setIsAdmin(true);
      setAdminAuthFailed(false);
      setAdminPassInput("");
      setShowAdminLogin(false);
    });
    socket.on("adminAuthFail", () => setAdminAuthFailed(true));
    socket.on("adminState", (s: any) => setAdminState(s));
    socket.on("adminLog", (entries: any[]) => {
      setAdminLogEntries(prev => [...prev, ...entries].slice(-200));
    });
    socket.on("adminLogHistory", (entries: any[]) => {
      setAdminLogEntries(entries);
    });
    socket.on("adminKickOk", () => {
      socketRef.current?.emit("adminGetState");
    });

    socket.on("roomList", (list: any[]) => { setActiveRooms(list); setRefreshingRooms(false); });
    socket.on("roomsUpdate", (list: any[]) => { setActiveRooms(list); setRefreshingRooms(false); });

    socket.on("quickMatchFound", (data: { roomId: string; playerCount: number }) => {
      setQuickMatchLoading(false);
      const pc = (data.playerCount === 6 ? 6 : 4) as 4 | 6;
      let name = "لاعب";
      try { name = localStorage.getItem("speet-name") || "لاعب"; } catch { /* ignore */ }
      setPlayerCount(pc);
      playerCountRef.current = pc;
      setStartMode("wait");
      startModeRef.current = "wait";
      initGameState(pc, data.roomId);
      setPhase("game");
      setIsHost(false);
      isHostRef.current = false;
      // Set pending join: claimSeat will be sent after seatUpdate arrives with current seats
      pendingJoinRef.current = { roomId: data.roomId, name };
      socket.emit("joinRoom", data.roomId, name);
    });

    // ── Lobby hall events ──────────────────────────────────────
    socket.on("lobbyPlayers", (list: {socketId: string; name: string}[]) => {
      setLobbyPlayers(list);
    });

    socket.on("lobbyMessage", (msg: {name: string; text: string; ts: number}) => {
      setLobbyMessages((prev) => [...prev.slice(-99), msg]);
    });

    socket.on("gameInvite", (data: {roomId: string; roomName: string; playerCount: number; inviterName: string}) => {
      setIncomingInvite(data);
    });

    socket.on("dealCards", (data: { seed: number; playerCount: number }) => {
      const hands = dealHands(data.playerCount, data.seed);
      // myIndex is captured via closure — read from ref
      setIsSorted(true); isSortedRef.current = true;
      const dealtHand = hands[myIndexRef.current];
      setOriginalHand([...dealtHand]);
      setMyHand(sortHand(dealtHand));
      playDealSound();
      setInGameSession(true);
      setRoundPhase("dealing");
      setSubmittedPurchases(new Array(data.playerCount).fill(null));
      setMySubmitted(false);
      setMyDraft(data.playerCount === 4 ? 2 : 1);
    });

    socket.on("startPurchasing", () => setRoundPhase("purchasing"));

    socket.on("purchaseOrderSet", (data: { order: number[] }) => {
      setPurchaseOrder(data.order);
    });

    socket.on("forcedBuyTeamSet", (data: { team: 0 | 1 | null }) => {
      setForcedBuyTeam(data.team);
      forcedBuyTeamRef.current = data.team;
    });

    socket.on("forcedBuyPlayerSet", (data: { player: number | null }) => {
      setForcedBuyPlayer(data.player);
      forcedBuyPlayerRef.current = data.player;
      if (data.player !== null && data.player === myIndexRef.current) {
        setMyDraft(playerCountRef.current === 4 ? 4 : 3);
      }
    });

    socket.on("purchaseSubmit", (data: { index: number; value: number }) => {
      setSubmittedPurchases((prev) => { const n = [...prev]; n[data.index] = data.value; return n; });
      // Show bid flash only for OTHER players (not myself)
      if (data.index !== myIndexRef.current) {
        const pName = playersRef.current[data.index]?.name ?? `لاعب ${data.index + 1}`;
        const pTeam = data.index % 2;
        const isTeammate = pTeam === (myIndexRef.current % 2);
        if (bidFlashTimerRef.current) clearTimeout(bidFlashTimerRef.current);
        setBidFlash({ name: pName, value: data.value, team: pTeam, isTeammate });
      }
    });

    socket.on("gameUpdate", (data: any) => {
      setTeam1Score(data.team1Score);
      setTeam2Score(data.team2Score);
      setRoundNumber(data.roundNumber);
      if (data.roundLog) setRoundLog(data.roundLog);
      if (typeof data.buyingTeam === "number" && data.buyingTeam !== -1) {
        const finishedRound = data.roundNumber - 1;
        setLastBuyRound((prev) => {
          const n: [number, number] = [prev[0], prev[1]];
          n[data.buyingTeam as 0 | 1] = finishedRound;
          lastBuyRoundRef.current = n;
          return n;
        });
      }
      if (typeof data.buyingPlayerSeat === "number" && data.buyingPlayerSeat !== -1) {
        const seat = data.buyingPlayerSeat as number;
        const finishedRound = data.roundNumber - 1;
        setPlayerLastBoughtRound((prev) => {
          const n = [...prev];
          n[seat] = finishedRound;
          playerLastBoughtRoundRef.current = n;
          return n;
        });
      }
      setForcedBuyTeam(null);
      forcedBuyTeamRef.current = null;
      setForcedBuyPlayer(null);
      forcedBuyPlayerRef.current = null;
      setSubmittedPurchases((prev) => new Array(prev.length).fill(null));
      setMySubmitted(false);
      setMyDraft(playerCountRef.current === 4 ? 2 : 1);
      setMyHand([]);
      setRoundPhase("dealing");
    });

    socket.on("roundReset", (data: { log: string }) => {
      setSubmittedPurchases((prev) => new Array(prev.length).fill(null));
      setMySubmitted(false);
      setMyDraft(playerCountRef.current === 4 ? 2 : 1);
      setMyHand([]);
      setRoundPhase("dealing");
      setRoundLog((prev) => [...prev, data.log]);
    });

    // ── Game state restoration on reconnect ───────────────────
    socket.on("gameState", (data: any) => {
      if (!data) return;
      // Restore scores and round info
      if (typeof data.team1Score === "number") setTeam1Score(data.team1Score);
      if (typeof data.team2Score === "number") setTeam2Score(data.team2Score);
      if (typeof data.roundNumber === "number") setRoundNumber(data.roundNumber);
      if (Array.isArray(data.roundLog)) setRoundLog(data.roundLog);
      setInGameSession(true);

      // Try to reconstruct hand for mid-round reconnect
      if (data.roundSeed && myIndexRef.current >= 0 && !isSpectatorRef.current) {
        const pc = data.playerCount || playerCountRef.current;
        const allHands = dealHands(pc, data.roundSeed);
        const originalHand = allHands[myIndexRef.current] ?? [];
        const plays: { seatIndex: number; card: string }[] = data.currentRoundPlays ?? [];
        const playedByMe = plays
          .filter((p) => p.seatIndex === myIndexRef.current)
          .map((p) => p.card);
        const remaining = originalHand.filter((c) => !playedByMe.includes(c));
        if (remaining.length > 0) {
          setMyHand(sortHand(remaining));
          setOriginalHand(sortHand(remaining));
          setRoundPhase("purchasing");
          toast({ title: "عدت للعبة! ✅", description: "تم استعادة يدك — أكمل جولتك", duration: 4000 });
        } else {
          toast({ title: "عدت للعبة! ✅", description: "في انتظار الجولة القادمة", duration: 3000 });
        }
      }
    });

    socket.on("webrtcSignal", async (data: any) => {
      // ── Lobby voice signal ──────────────────────────────────
      if (data.isLobby) {
        let pc = lobbyPcRef.current;
        if (!pc) {
          pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
          lobbyPcRef.current = pc;
          pc.onicecandidate = (e) => {
            if (e.candidate) socketRef.current?.emit("webrtcSignal", { candidate: e.candidate, roomId: "__lobby__", isLobby: true });
          };
          pc.ontrack = (e) => {
            const audio = document.createElement("audio");
            audio.srcObject = e.streams[0]; audio.autoplay = true;
            audio.setAttribute("playsinline", "");
            audio.muted = lobbyAudioMuted;
            lobbyAudioElRef.current = audio;
            document.body.appendChild(audio);
            audio.play().catch(() => {});
          };
          if (lobbyStreamRef.current) {
            lobbyStreamRef.current.getTracks().forEach(t => pc!.addTrack(t, lobbyStreamRef.current!));
          }
        }
        if (data.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          if (data.sdp.type === "offer") {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit("webrtcSignal", { sdp: pc.localDescription, roomId: "__lobby__", isLobby: true });
          }
        } else if (data.candidate) {
          try { await pc.addIceCandidate(data.candidate); } catch {}
        }
        return;
      }
      // ── Game voice signal ───────────────────────────────────
      let pc = pcRef.current;
      // Create receiver peer connection if an offer arrives while mic is off
      if (!pc && data.sdp?.type === "offer") {
        pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] });
        pcRef.current = pc;
        pc.onicecandidate = (e) => {
          if (e.candidate) socketRef.current?.emit("webrtcSignal", { candidate: e.candidate, roomId: roomIdRef.current });
        };
        pc.ontrack = (e) => {
          const a = document.createElement("audio");
          a.srcObject = e.streams[0]; a.autoplay = true;
          a.setAttribute("playsinline", "");
          document.body.appendChild(a);
          a.play().catch(() => {});
        };
      }
      if (!pc) return;
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("webrtcSignal", { sdp: pc.localDescription });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch {}
      }
    });

    socket.on("lobbyVoiceUsers", (users: string[]) => {
      setLobbyVoiceUsers(users);
    });

    socket.on("chatMessage", (data: any) => {
      if (typeof data.text === "string" && data.text.startsWith("__emoji__")) {
        const emoji = data.text.replace("__emoji__", "");
        const id = ++emojiIdRef.current;
        const x = 25 + Math.random() * 50;
        setEmojiReactions((prev) => [...prev, { id, name: data.sender, emoji, x }]);
        setTimeout(() => setEmojiReactions((prev) => prev.filter((r) => r.id !== id)), 2500);
      } else {
        setChatMessages((prev) => [...prev, data]);
      }
    });

    socket.on("seatUpdate", (seats: Record<number, string>) => {
      // Sync ref immediately (don't wait for useEffect) so fillBots/dealCards see fresh names
      claimedSeatsRef.current = { ...seats };
      setClaimedSeats({ ...seats });

      // Update players names from real seat data right away
      const pc = playerCountRef.current;
      if (pc > 0) {
        const myIdx = myIndexRef.current;
        setPlayers(prev => {
          const n = prev.length === pc ? [...prev] : Array.from({ length: pc }, (_, i) => ({
            name: i % 2 === 0 ? `عرباوي ${Math.floor(i / 2) + 1}` : `سداوي ${Math.floor(i / 2) + 1}`,
          }));
          for (let i = 0; i < pc; i++) {
            if (seats[i]) n[i] = { name: seats[i] };
            else if (i !== myIdx && !n[i]?.name) {
              const teamLabel = i % 2 === 0 ? "عرباوي" : "سداوي";
              n[i] = { name: `${teamLabel}${Math.floor(i / 2) + 1}` };
            }
          }
          return n;
        });
        // If any previously-bot seat is now claimed by a real player, remove it from botSeats
        const claimedIndices = Object.keys(seats).map(Number);
        if (claimedIndices.some(idx => botSeatsRef.current.has(idx))) {
          setBotSeats(prev => {
            const n = new Set(prev);
            claimedIndices.forEach(idx => n.delete(idx));
            return n;
          });
          botSeatsRef.current = new Set(
            Array.from(botSeatsRef.current).filter(idx => !claimedIndices.includes(idx))
          );
        }
      }

      // If we have a pending join, pick the next free seat now that we know who's seated
      if (pendingJoinRef.current) {
        const { roomId, name } = pendingJoinRef.current;
        pendingJoinRef.current = null;
        const taken = Object.keys(seats).map(Number);
        let nextSeat = 0;
        for (let i = 0; i < pc; i++) {
          if (!taken.includes(i)) { nextSeat = i; break; }
        }
        setMyIndex(nextSeat);
        myIndexRef.current = nextSeat;
        // Also immediately update our own name in the players array
        setPlayers(prev => {
          const n = [...prev];
          if (n[nextSeat]) n[nextSeat] = { name };
          return n;
        });
        socket.emit("claimSeat", { roomId, index: nextSeat, name });
      }
    });

    socket.on("playerOffline", (data: { seatIndex: number; name: string }) => {
      setOfflineSeats((prev) => new Set(Array.from(prev).concat(data.seatIndex)));
      toast({ title: `${data.name} انقطع الاتصال`, description: "قد يعود قريباً…", variant: "destructive", duration: 3000 });
    });

    socket.on("playerOnline", (data: { seatIndex: number; name: string }) => {
      setOfflineSeats((prev) => { const s = new Set(prev); s.delete(data.seatIndex); return s; });
      toast({ title: `${data.name} عاد للعبة!`, description: "اتصال ناجح", duration: 3000 });
    });

    socket.on("restartGame", () => {
      handleReset(true);
    });

    socket.on("spectatorList", (specs: { name: string; socketId: string }[]) => {
      // Detect new spectator joining
      const newSpec = specs.find(s => !prevSpectatorIdsRef.current.has(s.socketId));
      if (newSpec) {
        setSpectatorJoinName(newSpec.name);
        setTimeout(() => setSpectatorJoinName(null), 3500);
      }
      prevSpectatorIdsRef.current = new Set(specs.map(s => s.socketId));
      setSpectators(specs);
    });

    socket.on("startPlaying", (data: { leader: number; tricksTotal: number; playerCount: number }) => {
      const tw = new Array(data.playerCount).fill(0);
      trickCardsRef.current = [];
      tricksWonRef.current = tw;
      trickNumberRef.current = 0;
      trickLeaderRef.current = data.leader;
      currentTurnRef.current = data.leader;
      totalTricksRef.current = data.tricksTotal;
      playingPhaseRef.current = true;
      setTrickCards([]);
      setTricksWon(tw);
      setTrickNumber(0);
      setTrickLeader(data.leader);
      setCurrentTurn(data.leader);
      setLastTrickWinner(null);
      roundStartTimeRef.current = Date.now();
      setRoundDuration(null);
      setPlayingPhase(true);
      setBidFlash(null);
    });

    socket.on("cardPlayed", (data: { playerIndex: number; card: CardStr }) => {
      playCardSound();
      applyCardRef.current(data.playerIndex, data.card);
    });

    // ── Mid-game bot-takeover events ─────────────────────────
    // New player joining active room gets the list of bot seats
    socket.on("botSeatsList", (seats: number[]) => {
      if (seats.length > 0) {
        setJoinBotSeats(seats);
        setNeedsSeatPick(true);
      }
    });

    // Non-host clients receive the full bot seat list when host updates it
    socket.on("botSeatsSync", (seats: number[]) => {
      if (isHostRef.current) return; // host already has correct state
      const s = new Set<number>(seats);
      botSeatsRef.current = s;
      setBotSeats(s);
    });

    // Host receives a seat-take request from a new player
    socket.on("takeSeatRequest", (data: { seat: number; name: string; socketId: string }) => {
      if (!isHostRef.current) return;
      const seat = data.seat;
      if (!botSeatsRef.current.has(seat)) return;
      const hand = botHandsRef.current[seat];
      if (!hand) return;
      // Send the hand back to the requesting socket and broadcast seat change
      socketRef.current?.emit("takeSeatGrant", {
        roomId: roomIdRef.current,
        seat,
        name: data.name,
        hand,
        socketId: data.socketId,
      });
      // Update host's local state
      setBotSeats(prev => { const n = new Set(prev); n.delete(seat); return n; });
      setPlayers(prev => { const n = [...prev]; if (n[seat]) n[seat] = { ...n[seat], name: data.name }; return n; });
      delete botHandsRef.current[seat];
    });

    // The requesting player receives their granted hand and seat
    socket.on("takeSeatGrant", (data: { seat: number; name: string; hand: string[] }) => {
      const seat = data.seat;
      myIndexRef.current = seat;
      setMyIndex(seat);
      const takenHand = data.hand as CardStr[];
      setOriginalHand([...takenHand]);
      setMyHand(sortHand(takenHand));
      setInGameSession(true);
      setNeedsSeatPick(false);
      setJoinBotSeats([]);
      socketRef.current?.emit("claimSeat", { roomId: roomIdRef.current, index: seat, name: data.name });
    });

    // All clients: a bot seat was taken by a human
    socket.on("seatTaken", (data: { seat: number; name: string }) => {
      setBotSeats(prev => { const n = new Set(prev); n.delete(data.seat); return n; });
      setPlayers(prev => {
        const n = [...prev];
        if (n[data.seat]) n[data.seat] = { ...n[data.seat], name: data.name };
        return n;
      });
    });

    return () => { socket.disconnect(); };
  }, []);

  // keep myIndex & isHost in refs so socket closures can read them
  const myIndexRef = useRef(myIndex);
  useEffect(() => { myIndexRef.current = myIndex; }, [myIndex]);
  const isHostRef = useRef(isHost);
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);

  // Mid-game join: seat picker state
  const [needsSeatPick, setNeedsSeatPick] = useState(false);
  const [joinBotSeats, setJoinBotSeats] = useState<number[]>([]);

  useEffect(() => { try { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); } catch { chatEndRef.current?.scrollIntoView(); } }, [chatMessages]);

  // Lobby hall: join/leave when rooms phase changes
  useEffect(() => {
    if (!socketRef.current) return;
    if (phase === "rooms") {
      let name = playerName || "لاعب";
      try { name = localStorage.getItem("speet-name") || name; } catch { /* ignore */ }
      socketRef.current.emit("joinLobby", name);
    } else {
      socketRef.current.emit("leaveLobby");
      // Stop lobby voice if active
      if (lobbyStreamRef.current) {
        lobbyStreamRef.current.getTracks().forEach(t => t.stop());
        lobbyStreamRef.current = null;
      }
      if (lobbyPcRef.current) { lobbyPcRef.current.close(); lobbyPcRef.current = null; }
      setLobbyMicOn(false);
    }
  }, [phase]);

  // Auto-scroll lobby chat
  useEffect(() => { try { lobbyMsgEndRef.current?.scrollIntoView({ behavior: "smooth" }); } catch { lobbyMsgEndRef.current?.scrollIntoView(); } }, [lobbyMessages]);

  // ── Keep applyCard callback fresh every render ──────────────
  useEffect(() => {
    applyCardRef.current = (pi: number, card: CardStr) => {
      if (!playingPhaseRef.current) return;
      // Snapshot blackJokerSeen at the very start of each trick
      if (trickCardsRef.current.length === 0) {
        blackJokerSeenBeforeTrickRef.current = blackJokerPlayedRef.current;
      }
      // Track black joker being played
      if (card === JOKER_B) {
        blackJokerPlayedRef.current = true;
        setBlackJokerPlayed(true);
      }
      // Track trump plays per player (for end-of-game stats)
      if (cardSuit(card) === TRUMP) {
        trumpPlaysThisRoundRef.current[pi] = (trumpPlaysThisRoundRef.current[pi] ?? 0) + 1;
      }
      // Track every played card so host can reconstruct remaining hands (offline-player coverage)
      if (botPlayedRef.current[pi]) botPlayedRef.current[pi].add(card);
      // Global card memory for bot card-counting strategy
      allPlayedCardsRef.current.add(card);
      const newTrick = [...trickCardsRef.current, { pi, card }];
      trickCardsRef.current = newTrick;
      setTrickCards([...newTrick]);
      const pc = playerCountRef.current;
      if (newTrick.length === pc) {
        setTrickAnimating(true);
        setTimeout(() => {
          setTrickAnimating(false);

          // Check: did someone play JOKER_R before the black joker had been seen?
          const redEntry = newTrick.find((e) => e.card === JOKER_R);
          const blackJokerInThisTrick = newTrick.some((e) => e.card === JOKER_B);
          // Not premature if JOKER_B was also played in this very trick (red joker legally beats it)
          const prematureRed = redEntry && !blackJokerSeenBeforeTrickRef.current && !blackJokerInThisTrick;

          let winnerPi: number;
          if (prematureRed) {
            // Red joker is treated as a losing card — winner is the strongest card among the OTHER players
            const trickWithoutRed = newTrick.filter((e) => e.card !== JOKER_R);
            winnerPi = trickWithoutRed.length > 0 ? trickWinner(trickWithoutRed) : newTrick[0].pi;
            setLastTrickForfeited(true);
          } else {
            winnerPi = trickWinner(newTrick);
            setLastTrickForfeited(false);
          }

          const newTW = [...tricksWonRef.current];
          newTW[winnerPi]++;
          tricksWonRef.current = newTW;
          setTricksWon([...newTW]);
          const newTN = trickNumberRef.current + 1;
          trickNumberRef.current = newTN;
          setTrickNumber(newTN);
          // ── Save last trick cards for "show last trick" overlay
          setLastTrickCards([...newTrick]);
          trickCardsRef.current = [];
          setTrickCards([]);
          // Update snapshot for next trick
          blackJokerSeenBeforeTrickRef.current = blackJokerPlayedRef.current;
          trickLeaderRef.current = winnerPi;
          setTrickLeader(winnerPi);
          currentTurnRef.current = winnerPi;
          setCurrentTurn(winnerPi);
          setLastTrickWinner(winnerPi);
          // ── Sound + vibration + banner based on who won ───────
          if (!isSpectatorRef.current) {
            const myTeam = myIndexRef.current % 2;
            const myTeamWon = winnerPi % 2 === myTeam;
            if (myTeamWon) playTrickWinSound(); else playTrickLoseSound();
            // Voice announcement for trick result
            if (winnerPi === myIndexRef.current) {
              setTimeout(() => speakArabic("أكلتها!", 0.95, 1.25), 900);
            } else if (!myTeamWon) {
              // Occasionally taunt when opponent wins
              if (Math.random() < 0.3) setTimeout(() => speakArabic("أكلها الخصم", 0.9, 0.95), 900);
            }
            // Trick winner flash on avatar
            if (trickWinnerBannerTimerRef.current) clearTimeout(trickWinnerBannerTimerRef.current);
            setTrickWinnerBanner(winnerPi);
            trickWinnerBannerTimerRef.current = setTimeout(() => setTrickWinnerBanner(null), 1800);
          }
          // ── Update last tricks log (keep last 4) ─────────────
          setLastTricksLog(prev => {
            const entry = {
              winnerName: playersRef.current[winnerPi]?.name ?? `لاعب ${winnerPi + 1}`,
              teamWon: winnerPi % 2,
              trickNum: newTN,
            };
            return [...prev.slice(-3), entry];
          });
          // ── Update session tricks counter ─────────────────────
          if (!isSpectatorRef.current && winnerPi % 2 === myIndexRef.current % 2) {
            setSessionStats(prev => {
              const next = { ...prev, tricks: prev.tricks + 1 };
              try { localStorage.setItem("speet-stats", JSON.stringify(next)); } catch { /* ignore */ }
              return next;
            });
          }
          // ── Lawrence early-end: opposing team won even ONE trick ─
          const purchL = submittedPurchasesRef.current;
          const totalTR = totalTricksRef.current;
          const t1BidL = purchL.filter((_, i) => i % 2 === 0).reduce<number>((a, v) => a + (v ?? 0), 0);
          const t2BidL = purchL.filter((_, i) => i % 2 !== 0).reduce<number>((a, v) => a + (v ?? 0), 0);
          const t1LawrActive = t1BidL >= totalTR;
          const t2LawrActive = t2BidL >= totalTR;
          const t1ActualNow = newTW.filter((_, i) => i % 2 === 0).reduce((a, v) => a + v, 0);
          const t2ActualNow = newTW.filter((_, i) => i % 2 !== 0).reduce((a, v) => a + v, 0);
          const lawrenceEarlyEnd =
            (t1LawrActive && t2ActualNow > 0) ||
            (t2LawrActive && t1ActualNow > 0);

          if (lawrenceEarlyEnd || newTN >= totalTR) {
            playingPhaseRef.current = false;
            setPlayingPhase(false);
            if (roundStartTimeRef.current !== null) {
              setRoundDuration(Math.floor((Date.now() - roundStartTimeRef.current) / 1000));
              roundStartTimeRef.current = null;
            }
            computeResultRef.current(newTW);
          }
        }, 1600);
      } else {
        const next = (pi + 1) % pc;
        currentTurnRef.current = next;
        setCurrentTurn(next);
      }
    };
  });

  // ── Compute round result after all tricks ────────────────────
  useEffect(() => {
    computeResultRef.current = (tw: number[]) => {
      const purch = submittedPurchasesRef.current;
      const pc = playerCountRef.current;
      const totalTricks = pc === 4 ? 13 : 9;
      // Alternating teams: even seats = العربي (team1), odd seats = السد (team2)
      const t1Bid = purch.filter((_, i) => i % 2 === 0).reduce<number>((a, v) => a + (v ?? 0), 0);
      const t2Bid = purch.filter((_, i) => i % 2 !== 0).reduce<number>((a, v) => a + (v ?? 0), 0);
      const t1Actual = tw.filter((_, i) => i % 2 === 0).reduce((a, v) => a + v, 0);
      const t2Actual = tw.filter((_, i) => i % 2 !== 0).reduce((a, v) => a + v, 0);
      const maxS = maxScoreRef.current;
      const nextRound = roundNumberRef.current + 1;
      // Buying team = whichever bid more; lawrence team counts as buying team
      const buyingTeam: number = t1Bid >= totalTricks ? 0 : t2Bid >= totalTricks ? 1 : (t1Bid > t2Bid ? 0 : t2Bid > t1Bid ? 1 : -1);
      // Determine buying player (seat with highest bid in winning team)
      let buyingPlayerSeat = -1;
      if (buyingTeam !== -1) {
        let maxBid = -1;
        for (let i = buyingTeam; i < pc; i += 2) {
          if ((purch[i] ?? 0) > maxBid) { maxBid = purch[i] ?? 0; buyingPlayerSeat = i; }
        }
      }
      // Update lastBuyRound locally (host side)
      if (buyingTeam !== -1) {
        const updated: [number, number] = [...lastBuyRoundRef.current];
        updated[buyingTeam as 0 | 1] = roundNumberRef.current;
        lastBuyRoundRef.current = updated;
        setLastBuyRound(updated);
      }
      // Update playerLastBoughtRound locally (host side)
      if (buyingPlayerSeat !== -1) {
        const updatedPlbr = [...playerLastBoughtRoundRef.current];
        updatedPlbr[buyingPlayerSeat] = roundNumberRef.current;
        playerLastBoughtRoundRef.current = updatedPlbr;
        setPlayerLastBoughtRound([...updatedPlbr]);
      }
      // ── Helper: handle game end (sound + session stats) ──────────
      const triggerGameEnd = (winLabel: string, withLawrence = false) => {
        if (!isSpectatorRef.current) {
          const myTeam = myIndexRef.current % 2;
          const myTeamLabel = myTeam === 0 ? "العربي" : "السد";
          const won = winLabel === myTeamLabel;
          if (withLawrence) playLawrenceSound();
          setTimeout(() => { if (won) playGameWinSound(); else playGameLoseSound(); }, withLawrence ? 700 : 0);
          // Voice game end announcement
          const delay = withLawrence ? 3500 : 800;
          if (won) {
            setTimeout(() => speakArabic("فاز فريقك! أحسنتم!", 0.8, 1.2), delay);
          } else {
            setTimeout(() => speakArabic("خسر فريقك. حظاً أوفر!", 0.8, 0.9), delay);
          }
          setSessionStats(prev => {
            const next = { ...prev, wins: prev.wins + (won ? 1 : 0), losses: prev.losses + (won ? 0 : 1) };
            try { localStorage.setItem("speet-stats", JSON.stringify(next)); } catch { /* ignore */ }
            return next;
          });
        }
      };
      // ── لورنس detection: team bid all tricks ──
      const t1Lawrence = t1Bid >= totalTricks;
      const t2Lawrence = t2Bid >= totalTricks;
      if (t1Lawrence) {
        if (t1Actual === totalTricks) {
          const log = "🏆 لورنس! العربي اشترى وربح جميع الكروت " + totalTricks + "/" + totalTricks + " – فوز باللورنس!";
          setRoundLog((prev) => [...prev, log]);
          socketRef.current?.emit("gameUpdate", { roomId: roomIdRef.current, team1Score: maxS, team2Score: team2ScoreRef.current, roundNumber: nextRound, roundLog: [...roundLogRef.current, log], buyingTeam, buyingPlayerSeat });
          setTeam1Score(maxS); setTeam2Score(team2ScoreRef.current);
          setSubmittedPurchases(new Array(pc).fill(null));
          setMySubmitted(false); setMyDraft(playerCountRef.current === 4 ? 2 : 1); setMyHand([]); setRoundPhase("dealing");
          setRoundNumber((r) => r + 1);
          triggerGameEnd("العربي", true);
          setWinner("العربي"); setGameOver(true);
        } else {
          const log = "💀 لورنس خسران! العربي شرى لورنس لكن أخذ " + t1Actual + "/" + totalTricks + " فقط – السد يفوز!";
          setRoundLog((prev) => [...prev, log]);
          socketRef.current?.emit("gameUpdate", { roomId: roomIdRef.current, team1Score: team1ScoreRef.current, team2Score: maxS, roundNumber: nextRound, roundLog: [...roundLogRef.current, log], buyingTeam, buyingPlayerSeat });
          setTeam1Score(team1ScoreRef.current); setTeam2Score(maxS);
          setSubmittedPurchases(new Array(pc).fill(null));
          setMySubmitted(false); setMyDraft(playerCountRef.current === 4 ? 2 : 1); setMyHand([]); setRoundPhase("dealing");
          setRoundNumber((r) => r + 1);
          triggerGameEnd("السد", true);
          setWinner("السد"); setGameOver(true);
        }
        return;
      }
      if (t2Lawrence) {
        if (t2Actual === totalTricks) {
          const log = "🏆 لورنس! السد اشترى وربح جميع الكروت " + totalTricks + "/" + totalTricks + " – فوز باللورنس!";
          setRoundLog((prev) => [...prev, log]);
          socketRef.current?.emit("gameUpdate", { roomId: roomIdRef.current, team1Score: team1ScoreRef.current, team2Score: maxS, roundNumber: nextRound, roundLog: [...roundLogRef.current, log], buyingTeam, buyingPlayerSeat });
          setTeam1Score(team1ScoreRef.current); setTeam2Score(maxS);
          setSubmittedPurchases(new Array(pc).fill(null));
          setMySubmitted(false); setMyDraft(playerCountRef.current === 4 ? 2 : 1); setMyHand([]); setRoundPhase("dealing");
          setRoundNumber((r) => r + 1);
          triggerGameEnd("السد", true);
          setWinner("السد"); setGameOver(true);
        } else {
          const log = "💀 لورنس خسران! السد شرى لورنس لكن أخذ " + t2Actual + "/" + totalTricks + " فقط – العربي يفوز!";
          setRoundLog((prev) => [...prev, log]);
          socketRef.current?.emit("gameUpdate", { roomId: roomIdRef.current, team1Score: maxS, team2Score: team2ScoreRef.current, roundNumber: nextRound, roundLog: [...roundLogRef.current, log], buyingTeam, buyingPlayerSeat });
          setTeam1Score(maxS); setTeam2Score(team2ScoreRef.current);
          setSubmittedPurchases(new Array(pc).fill(null));
          setMySubmitted(false); setMyDraft(playerCountRef.current === 4 ? 2 : 1); setMyHand([]); setRoundPhase("dealing");
          setRoundNumber((r) => r + 1);
          triggerGameEnd("العربي", true);
          setWinner("العربي"); setGameOver(true);
        }
        return;
      }
      // ── Accumulate stats ──
      const pc2 = playerCountRef.current;
      setGameStats(prev => {
        const prevTricks = prev.tricksPerPlayer.length === pc2 ? prev.tricksPerPlayer : new Array(pc2).fill(0);
        const prevTrumps = prev.trumpPerPlayer.length === pc2 ? prev.trumpPerPlayer : new Array(pc2).fill(0);
        return {
          tricksPerPlayer: prevTricks.map((v, i) => v + (tw[i] ?? 0)),
          trumpPerPlayer: prevTrumps.map((v, i) => v + (trumpPlaysThisRoundRef.current[i] ?? 0)),
        };
      });
      trumpPlaysThisRoundRef.current = new Array(pc2).fill(0);

      // ── Sweep bonus: a team with a normal bid wins ALL tricks → +2 bonus ──
      const t1Sweep = !t1Lawrence && !t2Lawrence && t1Actual === totalTricks;
      const t2Sweep = !t1Lawrence && !t2Lawrence && t2Actual === totalTricks;

      // ── Normal scoring: win = +actual, fail = -bid only ──────────
      const t1Fail = t1Actual < t1Bid;
      const t2Fail = t2Actual < t2Bid;
      const t1BaseDelta = t1Fail ? -t1Bid : t1Actual;
      const t2BaseDelta = t2Fail ? -t2Bid : t2Actual;
      // Apply sweep bonus
      const t1Delta = t1BaseDelta + (t1Sweep ? 2 : 0);
      const t2Delta = t2BaseDelta + (t2Sweep ? 2 : 0);
      const newT1 = team1ScoreRef.current + t1Delta;
      const newT2 = team2ScoreRef.current + t2Delta;
      // Format: "7+" if reached, "6-" if failed (sweep adds "+2")
      const fmtT = (actual: number, bid: number, fail: boolean, sweep: boolean) => {
        if (fail) return bid + "-";
        return actual + "+" + (sweep ? " كشخة+2" : "");
      };
      const log = "جولة " + (roundNumberRef.current + 1) + ": العربي " + fmtT(t1Actual, t1Bid, t1Fail, t1Sweep) + " | السد " + fmtT(t2Actual, t2Bid, t2Fail, t2Sweep);
      const newLog = [...roundLogRef.current, log];

      // Show failed-bid banners (penalty = bid only)
      if (t1Fail) {
        if (failBidBannerTimerRef.current) clearTimeout(failBidBannerTimerRef.current);
        setFailBidBanner({ teamLabel: "العربي", bid: t1Bid, got: t1Actual, penalty: t1Bid });
        failBidBannerTimerRef.current = setTimeout(() => setFailBidBanner(null), 4000);
      } else if (t2Fail) {
        if (failBidBannerTimerRef.current) clearTimeout(failBidBannerTimerRef.current);
        setFailBidBanner({ teamLabel: "السد", bid: t2Bid, got: t2Actual, penalty: t2Bid });
        failBidBannerTimerRef.current = setTimeout(() => setFailBidBanner(null), 4000);
      }

      // Show sweep celebration banner
      if (t1Sweep) {
        if (sweepBannerTimerRef.current) clearTimeout(sweepBannerTimerRef.current);
        setSweepBannerTeam(0);
        sweepBannerTimerRef.current = setTimeout(() => setSweepBannerTeam(null), 4500);
      } else if (t2Sweep) {
        if (sweepBannerTimerRef.current) clearTimeout(sweepBannerTimerRef.current);
        setSweepBannerTeam(1);
        sweepBannerTimerRef.current = setTimeout(() => setSweepBannerTeam(null), 4500);
      }
      const w = newT1 >= maxS ? "العربي" : newT2 >= maxS ? "السد" : "";
      // Save per-player stats snapshot (bid vs actual) before resetting
      const playerStatsSnapshot = Array.from({ length: pc }, (_, i) => ({
        name: playersRef.current[i]?.name ?? `لاعب ${i + 1}`,
        bid: purch[i] ?? 0,
        actual: tw[i] ?? 0,
        team: i % 2,
      }));
      setLastRoundPlayerStats(playerStatsSnapshot);
      setTeam1Score(newT1);
      setTeam2Score(newT2);
      setRoundLog(newLog);
      setRoundNumber((r) => r + 1);
      setSubmittedPurchases(new Array(pc).fill(null));
      setMySubmitted(false); setMyDraft(playerCountRef.current === 4 ? 2 : 1); setMyHand([]); setRoundPhase("dealing");
      socketRef.current?.emit("gameUpdate", { roomId: roomIdRef.current, team1Score: newT1, team2Score: newT2, roundNumber: nextRound, roundLog: newLog, buyingTeam, buyingPlayerSeat });
      if (w) { triggerGameEnd(w); setWinner(w); setGameOver(true); return; }
      // ── No winner yet — auto-redeal after 3-second countdown ──
      if (isHostRef.current) {
        const summary = "العربي: " + (t1Fail ? t1Bid + "-" : t1Actual + "+") + " → " + newT1 + " | السد: " + (t2Fail ? t2Bid + "-" : t2Actual + "+") + " → " + newT2;
        setLastRoundSummary(summary);
        setNextRoundCountdown(3);
        let c = 3;
        const iv = setInterval(() => {
          c--;
          setNextRoundCountdown(c);
          if (c <= 0) {
            clearInterval(iv);
            setNextRoundCountdown(null);
            setLastRoundSummary(null);
            handleDealRef.current();
          }
        }, 1000);
      }
    };
  });

  // ── Bot countdown: 60 s after entering game phase (or instant if immediate) ──
  const handleDealRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (phase !== "game") return;

    const fillBots = (autoStart = false) => {
      const pc = playerCountRef.current;
      const newBots = new Set<number>();
      const newPlayers: { name: string }[] = [];
      const humanIdx = myIndexRef.current;
      const humanName = claimedSeatsRef.current[humanIdx] || playerName;
      for (let i = 0; i < pc; i++) {
        // Always protect the human player's seat — claimSeat may not have arrived yet
        if (i === humanIdx) {
          newPlayers.push({ name: humanName || `لاعب ${i + 1}` });
        } else if (claimedSeatsRef.current[i]) {
          newPlayers.push({ name: claimedSeatsRef.current[i] });
        } else {
          const teamLabel = i % 2 === 0 ? "عرباوي" : "سداوي";
          const teamNum = Math.floor(i / 2) + 1;
          const botName = `${teamLabel}${teamNum}`;
          newPlayers.push({ name: botName });
          newBots.add(i);
        }
      }
      if (newBots.size > 0) {
        // Update ref directly so handleDeal sees the bots immediately
        botSeatsRef.current = newBots;
        setBotSeats(newBots);
        setPlayers(newPlayers);
      }
      if (autoStart) {
        // Small delay to let React flush the state updates before dealing
        setTimeout(() => handleDealRef.current(), 100);
      }
    };

    if (startModeRef.current === "immediate") {
      setBotCountdown(null);
      fillBots(true); // Fill bots and auto-deal immediately
      return;
    }
    setBotCountdown(25);
    const interval = setInterval(() => {
      setBotCountdown((prev) => {
        if (prev === null || prev <= 1) { clearInterval(interval); return null; }
        return prev - 1;
      });
    }, 1000);
    const timeout = setTimeout(() => {
      // After 40 s: fill remaining seats with bots and auto-start
      fillBots(true);
    }, 40000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [phase]);

  // Derived purchase values (must be before any effect that uses them)
  const allSubmitted = submittedPurchases.every((v) => v !== null);
  const buyThreshold = playerCount === 4 ? 8 : 6;
  const team0Overdue = roundNumber - lastBuyRound[0] >= buyThreshold;
  const team1Overdue = roundNumber - lastBuyRound[1] >= buyThreshold;
  const half = playerCount / 2;
  // Sequential purchase turn: seat of next player to bid (-1 = all done)
  const purchaseTurn = (() => {
    if (purchaseOrder.length === 0) return submittedPurchases.findIndex(v => v === null);
    const nextIdx = purchaseOrder.findIndex(s => submittedPurchases[s] === null);
    return nextIdx === -1 ? -1 : purchaseOrder[nextIdx];
  })();
  useEffect(() => { purchaseTurnRef.current = purchaseTurn; }, [purchaseTurn]);

  // ── Purchase timer: 20 s for humans only — bots bid instantly ──
  useEffect(() => {
    if (myHand.length === 0 || playingPhase || isSpectatorRef.current) { setPurchaseTimer(null); return; }
    if (purchaseTurn === -1) { setPurchaseTimer(null); return; }
    // Only show timer when it's the human player's turn
    if (purchaseTurn !== myIndex) { setPurchaseTimer(null); return; }
    // Wait until the card-reveal overlay is gone before starting the bid timer
    if (cardsJustDealt) { setPurchaseTimer(null); return; }
    setPurchaseTimer(20);
    const interval = setInterval(() => {
      setPurchaseTimer((prev) => {
        if (prev === null) { clearInterval(interval); return null; }
        if (prev <= 1) {
          clearInterval(interval);
          // Auto-submit only if it is currently MY turn
          if (purchaseTurnRef.current === myIndexRef.current && !mySubmittedRef.current) {
            const forcedMin = playerCountRef.current === 4 ? 4 : 3;
            const minBid = forcedBuyPlayerRef.current === myIndexRef.current ? forcedMin : (playerCountRef.current === 4 ? 2 : 1);
            const rawVal = isHost ? hostDraftBidRef.current : myDraftRef.current;
            const val = Math.max(minBid, rawVal);
            const idx = myIndexRef.current;
            setSubmittedPurchases((p) => { const n = [...p]; n[idx] = val; return n; });
            setMySubmitted(true);
            socketRef.current?.emit("purchaseSubmit", { roomId: roomIdRef.current, index: idx, value: val });
          }
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchaseTurn, myHand.length, isHost, playingPhase, cardsJustDealt, myIndex]);

  // Stop timer when manually submitted
  useEffect(() => {
    if (mySubmitted) {
      setPurchaseTimer(null);
    }
  }, [mySubmitted]);

  // ── Sound: play "my turn" chime when trick-play turn reaches me ──
  useEffect(() => {
    if (!playingPhase || trickAnimating || isSpectatorRef.current) return;
    if (currentTurn !== myIndex) return;
    playMyTurnSound();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTurn, playingPhase, trickAnimating]);

  // ── Compute hint card for the human player ────────────────
  useEffect(() => {
    if (!playingPhase || trickAnimating || currentTurn !== myIndex || myHand.length === 0) {
      setHintCard(null); return;
    }
    const ledSuit = trickCards.length > 0 ? cardSuit(trickCards[0].card) : null;
    const valid = validCards(myHand, ledSuit, blackJokerPlayed, trickCards.some((e) => e.card === JOKER_B));
    if (valid.length === 0) { setHintCard(null); return; }
    const byPowerAsc  = (a: CardStr, b: CardStr) => cardPower(a) - cardPower(b);
    const byPowerDesc = (a: CardStr, b: CardStr) => cardPower(b) - cardPower(a);
    const beats = (c: CardStr) => trickWinner([...trickCards, { pi: myIndex, card: c }]) === myIndex;
    let hint: CardStr;
    if (trickCards.length === 0) {
      hint = valid.slice().sort(byPowerDesc)[0];
    } else {
      const winnerPi = trickWinner(trickCards);
      const teammateWinning = (winnerPi % 2) === (myIndex % 2);
      if (teammateWinning) {
        hint = valid.slice().sort(byPowerAsc)[0];
      } else {
        const beating = valid.filter(beats);
        hint = beating.length > 0 ? beating.slice().sort(byPowerAsc)[0] : valid.slice().sort(byPowerAsc)[0];
      }
    }
    setHintCard(hint);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTurn, playingPhase, trickAnimating, trickCards, myHand, blackJokerPlayed]);

  // ── Reset trick log between rounds ────────────────────────
  useEffect(() => {
    if (!playingPhase && myHand.length === 0) setLastTricksLog([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingPhase]);

  // ── Sound: play "my turn" chime when purchase turn reaches me ──
  useEffect(() => {
    if (playingPhase || cardsJustDealt || isSpectatorRef.current) return;
    if (purchaseTurn !== myIndex) return;
    playMyTurnSound();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchaseTurn, playingPhase, cardsJustDealt]);

  // Reset host draft bid when purchase turn advances
  useEffect(() => {
    if (isHost) {
      const isF = forcedBuyPlayerRef.current === purchaseTurn;
      const initVal = isF ? (playerCountRef.current === 4 ? 4 : 3) : (playerCountRef.current === 4 ? 2 : 1);
      setHostDraftBid(initVal); hostDraftBidRef.current = initVal;
    }
  }, [purchaseTurn, isHost]);

  // Keep hostDraftBidRef in sync
  useEffect(() => { hostDraftBidRef.current = hostDraftBid; }, [hostDraftBid]);

  // Show cards first for 2 seconds before enabling bid controls
  useEffect(() => {
    if (myHand.length === 0 || playingPhase) return;
    setCardsJustDealt(true);
    setDealRevealTimer(2);
    // Increment epoch to restart card-deal-in CSS animations
    setDealEpoch((e) => e + 1);
    // Show animated dealer hand for 2 seconds
    setShowDealHand(true);
    const handTimer = setTimeout(() => setShowDealHand(false), 2000);
    const countdown = setInterval(() => {
      setDealRevealTimer((prev) => {
        if (prev <= 1) { clearInterval(countdown); setCardsJustDealt(false); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => { clearInterval(countdown); clearTimeout(handTimer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myHand.length]);

  // Auto-start game when all purchases are in (host triggers)
  useEffect(() => {
    if (!isHost || !allSubmitted || gameOver || playingPhase || phase !== "game") return;
    if (submittedPurchasesRef.current.some((v) => v === null)) return;
    // Use ref so we always call the freshest handleNextRound (avoids stale closures)
    // 5-second delay so all players can read the purchase summary before game starts
    const t = setTimeout(() => handleNextRoundRef.current(), 5000);
    return () => clearTimeout(t);
  }, [allSubmitted, isHost, gameOver, playingPhase, phase]);

  // ── Lawrence detection: fires for every player (host and clients) ───────────
  useEffect(() => {
    if (playingPhase || gameOver || phase !== "game" || submittedPurchases.length === 0) return;
    const maxT = playerCount === 4 ? 13 : 9;
    const lawrSeatIdx = submittedPurchases.findIndex((v) => v !== null && v >= maxT);
    if (lawrSeatIdx === -1) return;

    // Show siren alert (only once per Lawrence bid event)
    if (!lawrenceAlertRef.current) {
      const pName = playersRef.current[lawrSeatIdx]?.name ?? `لاعب ${lawrSeatIdx + 1}`;
      const pTeam = lawrSeatIdx % 2;
      const alert = { playerName: pName, team: pTeam };
      lawrenceAlertRef.current = alert;
      setLawrenceAlert(alert);
      // Play police siren + Arabic shout
      playLawrenceSiren();
      setTimeout(() => speakLawrence(), 400);
      // Auto-dismiss after 5.5 seconds (purchase summary shows simultaneously)
      const t = setTimeout(() => {
        lawrenceAlertRef.current = null;
        setLawrenceAlert(null);
      }, 5500);
      return () => clearTimeout(t);
    }
  }, [submittedPurchases, playingPhase, gameOver, phase, playerCount]);

  // ── Hide Lawrence siren as soon as playing phase begins ──────────────────
  useEffect(() => {
    if (!playingPhase) return;
    lawrenceAlertRef.current = null;
    setLawrenceAlert(null);
  }, [playingPhase]);

  // ── Lawrence host auto-forfeit: instantly set remaining bids to 0 ──────────
  useEffect(() => {
    if (!isHost || playingPhase || gameOver || phase !== "game" || submittedPurchases.length === 0) return;
    const maxT = playerCount === 4 ? 13 : 9;
    const hasLawrence = submittedPurchases.some((v) => v !== null && v >= maxT);
    if (!hasLawrence) return;
    // Forfeit all remaining unbid seats with 0
    submittedPurchases.forEach((v, i) => {
      if (v !== null) return; // already submitted
      setSubmittedPurchases((prev) => {
        if (prev[i] !== null) return prev;
        const n = [...prev]; n[i] = 0; return n;
      });
      socketRef.current?.emit("purchaseSubmit", { roomId: roomIdRef.current, index: i, value: 0 });
    });
  }, [submittedPurchases, isHost, playingPhase, gameOver, phase, playerCount]);

  // ── Bot auto-play during trick phase ────────────────────────
  useEffect(() => {
    if (!playingPhase || trickAnimating) return;
    if (!botSeats.has(currentTurn)) return;
    const delay = 400 + Math.random() * 400;
    const t = setTimeout(() => {
      const bot = currentTurnRef.current;
      if (!botSeatsRef.current.has(bot)) return;
      const botHand = botHandsRef.current[bot] ?? [];
      const played = botPlayedRef.current[bot] ?? new Set<CardStr>();
      const remaining = botHand.filter((c) => !played.has(c));
      if (!remaining.length) return;
      const ledSuit = trickCardsRef.current.length > 0 ? cardSuit(trickCardsRef.current[0].card) : null;
      const botBlackInTrick = trickCardsRef.current.some((e) => e.card === JOKER_B);
      // validCards() uses blackJokerPlayedRef (ever played) OR botBlackInTrick (this trick) to unlock red joker
      let valid = validCards(remaining, ledSuit, blackJokerPlayedRef.current, botBlackInTrick);

      // ── Bot strategy by difficulty ───────────────────────────
      const currentTrick = trickCardsRef.current;
      let card: CardStr;

      const byPowerAsc  = (a: CardStr, b: CardStr) => cardPower(a) - cardPower(b);
      const byPowerDesc = (a: CardStr, b: CardStr) => cardPower(b) - cardPower(a);
      const botBeats = (c: CardStr) =>
        trickWinner([...currentTrick, { pi: bot, card: c }]) === bot;
      const activeDiff = botDifficultyRef.current;

      if (activeDiff === "easy") {
        // Easy: always random
        card = valid[Math.floor(Math.random() * valid.length)];
      } else if (activeDiff === "medium") {
        // Medium: current smart strategy
        if (currentTrick.length === 0) {
          card = valid.slice().sort(byPowerDesc)[0];
        } else {
          const currentWinnerPi = trickWinner(currentTrick);
          const teammateWinning = (currentWinnerPi % 2) === (bot % 2);
          if (teammateWinning) {
            card = valid.slice().sort(byPowerAsc)[0];
          } else {
            const beatingCards = valid.filter(botBeats);
            card = beatingCards.length > 0
              ? beatingCards.slice().sort(byPowerAsc)[0]
              : valid.slice().sort(byPowerAsc)[0];
          }
        }
      } else {
        // Hard: card-counting + joker conservation + non-joker beater preference
        const tricksRemaining = totalTricksRef.current - trickNumberRef.current;
        const teamTricksNeeded = submittedPurchasesRef.current
          .filter((_, i) => i % 2 === bot % 2).reduce<number>((a, v) => a + (v ?? 0), 0);
        const teamTricksWon = tricksWonRef.current
          .filter((_, i) => i % 2 === bot % 2).reduce((a, v) => a + v, 0);
        const needMoreTricks = teamTricksWon < teamTricksNeeded;
        // Desperate = team MUST win all remaining tricks just to meet bid
        const desperate = (teamTricksNeeded - teamTricksWon) >= tricksRemaining;
        // Card memory: what's globally played so far
        const globalPlayed = allPlayedCardsRef.current;
        // Non-joker valid cards: prefer spending these before precious jokers
        const nonJokerValid = valid.filter(c => c !== JOKER_B && c !== JOKER_R);
        // Cards that beat the current trick without using jokers
        const nonJokerBeaters = valid.filter(c => c !== JOKER_B && c !== JOKER_R && botBeats(c));
        // Whether a card is the highest remaining card in its suit (safe lead)
        const isSafeLead = (c: CardStr) => {
          const suit = cardSuit(c);
          const power = cardPower(c);
          // If all higher-power cards of same suit are already played, this card is a winner
          const higherInSuit = (c2: CardStr) => cardSuit(c2) === suit && cardPower(c2) > power;
          return !remaining.some(higherInSuit) && Array.from(globalPlayed).some(higherInSuit);
        };

        if (currentTrick.length === 0) {
          // ── Leading ──────────────────────────────────────────────
          if (desperate || tricksRemaining <= 1) {
            // Must win: play strongest card (use joker if needed)
            card = valid.slice().sort(byPowerDesc)[0];
          } else {
            // Look for safe non-joker lead (guaranteed winner)
            const safeLeads = nonJokerValid.filter(isSafeLead);
            if (safeLeads.length > 0) {
              // Lead with cheapest safe winner (save the big guns)
              card = safeLeads.slice().sort(byPowerAsc)[0];
            } else if (needMoreTricks) {
              // Need tricks: lead strongest non-joker (save jokers for tight spots)
              card = nonJokerValid.length > 0
                ? nonJokerValid.slice().sort(byPowerDesc)[0]
                : valid.slice().sort(byPowerDesc)[0];
            } else {
              // Comfortable: lead low to preserve strong cards & probe opponents
              card = nonJokerValid.length > 0
                ? nonJokerValid.slice().sort(byPowerAsc)[0]
                : valid.slice().sort(byPowerAsc)[0];
            }
          }
        } else {
          // ── Following ─────────────────────────────────────────────
          const currentWinnerPi = trickWinner(currentTrick);
          const teammateWinning = (currentWinnerPi % 2) === (bot % 2);

          if (teammateWinning) {
            // Partner is winning — let them take it, dump lowest non-joker
            card = nonJokerValid.length > 0
              ? nonJokerValid.slice().sort(byPowerAsc)[0]
              : valid.slice().sort(byPowerAsc)[0];
          } else {
            // Need to beat opponent
            if (nonJokerBeaters.length > 0) {
              // Prefer cheapest non-joker beater (save jokers for harder situations)
              card = (desperate || tricksRemaining <= 1)
                ? nonJokerBeaters.slice().sort(byPowerDesc)[0]
                : nonJokerBeaters.slice().sort(byPowerAsc)[0];
            } else {
              // Only jokers can win — use one only if trick is worth it
              const jokerBeaters = valid.filter(botBeats);
              if (jokerBeaters.length > 0 && (needMoreTricks || desperate || tricksRemaining <= 2)) {
                card = jokerBeaters.slice().sort(byPowerAsc)[0];
              } else {
                // Can't win or not worth joker: dump lowest card
                card = nonJokerValid.length > 0
                  ? nonJokerValid.slice().sort(byPowerAsc)[0]
                  : valid.slice().sort(byPowerAsc)[0];
              }
            }
          }
        }
      }
      played.add(card);
      botPlayedRef.current[bot] = played;
      playCardSound();
      socketRef.current?.emit("cardPlayed", { roomId: roomIdRef.current, playerIndex: bot, card });
      applyCardRef.current(bot, card);
    }, delay);
    return () => clearTimeout(t);
  }, [playingPhase, currentTurn, trickAnimating, botSeats]);

  // ── Host auto-plays for offline human players during trick phase ────
  // Triggers 8 s after turn lands on an offline seat; cancels if they reconnect
  useEffect(() => {
    if (!playingPhase || trickAnimating) return;
    if (!isHostRef.current) return;
    if (botSeats.has(currentTurn)) return; // bots handled separately
    if (!offlineSeats.has(currentTurn)) return;
    const seat = currentTurn;
    const t = setTimeout(() => {
      // Double-check they're still offline and it's still their turn
      if (!offlineSeatsRef.current.has(seat)) return;
      if (currentTurnRef.current !== seat) return;
      if (botSeatsRef.current.has(seat)) return;
      const hand = botHandsRef.current[seat] ?? [];
      const played = botPlayedRef.current[seat] ?? new Set<CardStr>();
      const remaining = hand.filter((c) => !played.has(c));
      if (!remaining.length) return;
      const ledSuit = trickCardsRef.current.length > 0 ? cardSuit(trickCardsRef.current[0].card) : null;
      const botBlackInTrick = trickCardsRef.current.some((e) => e.card === JOKER_B);
      const valid = validCards(remaining, ledSuit, blackJokerPlayedRef.current, botBlackInTrick);
      const card = valid[Math.floor(Math.random() * valid.length)];
      if (card) {
        played.add(card);
        botPlayedRef.current[seat] = played;
        socketRef.current?.emit("cardPlayed", { roomId: roomIdRef.current, playerIndex: seat, card });
        applyCardRef.current(seat, card);
      }
    }, 8000);
    return () => clearTimeout(t);
  }, [playingPhase, currentTurn, trickAnimating, offlineSeats, botSeats]);

  // ── 20-second play timer (visible to ALL players; auto-plays only for the active player) ──
  useEffect(() => {
    if (!playingPhase || trickAnimating || isSpectatorRef.current) { setPlayTimer(null); playTimerRef.current = null; return; }
    if (myHand.length === 0 && currentTurn !== myIndex) { setPlayTimer(null); playTimerRef.current = null; return; }
    if (botSeatsRef.current.has(currentTurn)) { setPlayTimer(null); playTimerRef.current = null; return; }
    // Start countdown from 20 whenever the turn changes
    setPlayTimer(20);
    playTimerRef.current = 20;
    const interval = setInterval(() => {
      const next = (playTimerRef.current ?? 1) - 1;
      playTimerRef.current = next;
      setPlayTimer(next);
      if (next <= 0) {
        clearInterval(interval);
        // Auto-play only if it is MY turn
        if (currentTurnRef.current === myIndex) {
          const hand = myHandRef.current;
          if (!hand.length) return;
          const ledSuit = trickCardsRef.current.length > 0 ? cardSuit(trickCardsRef.current[0].card) : null;
          const valid = validCards(hand, ledSuit, blackJokerPlayedRef.current, trickCardsRef.current.some((e) => e.card === JOKER_B));
          const card = valid[Math.floor(Math.random() * valid.length)];
          if (card) {
            setMyHand((prev) => sortHand(prev.filter((c) => c !== card)));
            socketRef.current?.emit("cardPlayed", { roomId: roomIdRef.current, playerIndex: myIndex, card });
            applyCardRef.current(myIndex, card);
          }
        }
      }
    }, 1000);
    return () => { clearInterval(interval); setPlayTimer(null); playTimerRef.current = null; };
  }, [playingPhase, currentTurn, trickAnimating, myIndex]);

  // ── Bot purchases: sequential — only submit when it's their turn ─────
  useEffect(() => {
    if (myHand.length === 0 || purchaseTurn === -1) return;
    if (!botSeatsRef.current.has(purchaseTurn)) return;
    const idx = purchaseTurn;
    const pc = playerCountRef.current;
    const maxCards = pc === 4 ? 13 : 9;
    const forced = forcedBuyTeamRef.current;
    const absoluteMin = pc === 4 ? 2 : 1;
    const botHand = botHandsRef.current[idx] ?? [];
    const diff = botDifficultyRef.current;

    // ── Realistic hand-strength evaluation ──────────────────────────────
    const hasBlackJoker = botHand.includes(JOKER_B);
    const hasRedJoker   = botHand.includes(JOKER_R);
    const spadeCards    = botHand.filter(c => cardSuit(c) === TRUMP && c !== JOKER_B && c !== JOKER_R);
    const spadeCount    = spadeCards.length;

    let rawStr = 0;

    // Jokers: near-certain tricks
    if (hasBlackJoker) rawStr += 1.8;
    if (hasRedJoker)   rawStr += 1.4;

    // High spades: value depends on supporting length
    const hasAceS   = spadeCards.some(c => c.startsWith("A"));
    const hasKingS  = spadeCards.some(c => c.startsWith("K"));
    const hasQueenS = spadeCards.some(c => c.startsWith("Q"));
    const hasJackS  = spadeCards.some(c => c.startsWith("J"));

    if (hasAceS)                           rawStr += 1.1;
    if (hasKingS  && spadeCount >= 2)      rawStr += 0.75;
    else if (hasKingS)                     rawStr += 0.4;
    if (hasQueenS && spadeCount >= 3)      rawStr += 0.5;
    if (hasJackS  && spadeCount >= 4)      rawStr += 0.3;

    // Extra (lower) spades: small protection value
    const topCount   = [hasAceS, hasKingS, hasQueenS, hasJackS].filter(Boolean).length;
    const extraSpades = Math.max(0, spadeCount - topCount);
    rawStr += extraSpades * 0.2;

    // Non-trump high cards
    const nsAces  = botHand.filter(c => c.startsWith("A") && cardSuit(c) !== TRUMP && c !== JOKER_B && c !== JOKER_R).length;
    const nsKings = botHand.filter(c => c.startsWith("K") && cardSuit(c) !== TRUMP && c !== JOKER_B && c !== JOKER_R).length;
    rawStr += nsAces  * 0.5;
    rawStr += nsKings * 0.2;

    // Voids in non-trump suits with spade support → can ruff early
    for (const suit of ["♥", "♦", "♣"]) {
      const len = botHand.filter(c => c.endsWith(suit)).length;
      if (len === 0 && spadeCount >= 2) rawStr += 0.45;
      else if (len === 1 && spadeCount >= 2) rawStr += 0.12;
    }

    // 6-player: fewer cards → scale down slightly
    if (pc === 6) rawStr *= 0.78;

    // Noise: easy bots deviate more (less accurate reads); hard bots are precise
    const noiseFactor = diff === "easy" ? 0.5 : diff === "hard" ? 0.07 : 0.2;
    const noise = rawStr * noiseFactor * (Math.random() * 2 - 1);
    const bid_raw = rawStr + noise;

    let bid: number;
    if (forced !== null && idx % 2 !== forced) {
      bid = 0;
    } else if (forced !== null && idx % 2 === forced) {
      bid = Math.round(Math.min(maxCards - 1, Math.max(absoluteMin, bid_raw * 0.92)));
    } else {
      bid = Math.round(Math.min(maxCards - 1, Math.max(absoluteMin, bid_raw)));
    }

    const delay = 80 + Math.random() * 120;
    const t = setTimeout(() => {
      setSubmittedPurchases((prev) => {
        if (prev[idx] !== null) return prev;
        const n = [...prev]; n[idx] = bid; return n;
      });
      // Only the host broadcasts to the server to avoid duplicate submissions
      if (isHostRef.current) {
        socketRef.current?.emit("purchaseSubmit", { roomId: roomIdRef.current, index: idx, value: bid });
      }
    }, delay);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchaseTurn, myHand.length, botSeats]);

  // ── Host auto-bids for offline human players during purchasing phase ────
  // Triggers 8 s after turn lands on an offline seat; submits minimum bid
  useEffect(() => {
    if (myHand.length === 0 || purchaseTurn === -1) return;
    if (!isHostRef.current) return;
    if (botSeats.has(purchaseTurn)) return; // bots handled separately
    if (!offlineSeats.has(purchaseTurn)) return;
    const idx = purchaseTurn;
    const absoluteMin = playerCountRef.current === 4 ? 2 : 1;
    const t = setTimeout(() => {
      if (!offlineSeatsRef.current.has(idx)) return; // reconnected
      if (purchaseTurnRef.current !== idx) return; // turn moved
      if (botSeatsRef.current.has(idx)) return;
      setSubmittedPurchases((prev) => {
        if (prev[idx] !== null) return prev;
        const n = [...prev]; n[idx] = absoluteMin; return n;
      });
      socketRef.current?.emit("purchaseSubmit", { roomId: roomIdRef.current, index: idx, value: absoluteMin });
    }, 8000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchaseTurn, myHand.length, offlineSeats, botSeats]);

  // ── Universal safety: host forces bid after 15 s for ANY stuck seat ──────
  // Catches ghost players (connected-but-unresponsive) and any sync gaps
  useEffect(() => {
    if (myHand.length === 0 || purchaseTurn === -1) return;
    if (!isHostRef.current) return;
    if (purchaseTurn === myIndexRef.current) return; // human player has their own timer
    const idx = purchaseTurn;
    const absoluteMin = playerCountRef.current === 4 ? 2 : 1;
    const t = setTimeout(() => {
      if (purchaseTurnRef.current !== idx) return; // already moved on
      setSubmittedPurchases((prev) => {
        if (prev[idx] !== null) return prev;
        const n = [...prev]; n[idx] = absoluteMin; return n;
      });
      socketRef.current?.emit("purchaseSubmit", { roomId: roomIdRef.current, index: idx, value: absoluteMin });
    }, 15000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchaseTurn, myHand.length]);

  // ── Helpers ───────────────────────────────────────────────
  const buildPlayers = useCallback((count: number) => {
    return Array.from({ length: count }, (_, i) => ({
      name: i % 2 === 0 ? `عرباوي ${Math.floor(i / 2) + 1}` : `سداوي ${Math.floor(i / 2) + 1}`,
    }));
  }, []);

  // ── Vibration when it's my turn ──────────────────────────────
  const myIndexRef2 = useRef(0);
  useEffect(() => { myIndexRef2.current = myIndex; }, [myIndex]);
  useEffect(() => {
    if (!playingPhase || isSpectatorRef.current) return;
    if (currentTurn !== myIndex) return;
    if (vibrationEnabledRef.current) {
      try { navigator.vibrate?.(80); } catch { /* ignore */ }
    }
  }, [currentTurn, playingPhase, myIndex]);

  // ── Auto-hint: activate hint when it's my turn and autoHint is on ──
  useEffect(() => {
    if (autoHint && playingPhase && currentTurn === myIndex && !trickAnimating) {
      setShowHint(true);
    } else if (!autoHint) {
      // keep whatever the user toggled manually
    }
  }, [autoHint, currentTurn, myIndex, playingPhase, trickAnimating]);


  // ── Purchase summary: show for 5s with countdown when all players submitted ──
  useEffect(() => {
    if (!submittedPurchases.length) return;
    const allDone = submittedPurchases.every((v) => v !== null);
    if (allDone && !playingPhase) {
      const SUMMARY_SECS = 5;
      setPurchaseSummaryVisible(true);
      setPurchaseCountdown(SUMMARY_SECS);
      // Tick down every second
      let remaining = SUMMARY_SECS;
      const tick = setInterval(() => {
        remaining -= 1;
        setPurchaseCountdown(remaining > 0 ? remaining : null);
        if (remaining <= 0) clearInterval(tick);
      }, 1000);
      const hide = setTimeout(() => {
        setPurchaseSummaryVisible(false);
        setPurchaseCountdown(null);
      }, SUMMARY_SECS * 1000 + 500);
      return () => { clearInterval(tick); clearTimeout(hide); };
    }
  }, [submittedPurchases, playingPhase]);

  // ── Celebration: trigger fireworks when game ends ─────────────
  useEffect(() => {
    if (gameOver && winner) {
      setShowCelebration(true);
      const t = setTimeout(() => setShowCelebration(false), 6500);
      return () => clearTimeout(t);
    }
  }, [gameOver, winner]);

  // ── Fullscreen sync (standard + webkit prefix for older Safari) ──
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!(document.fullscreenElement || (document as any).webkitFullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, []);
  const toggleFullscreen = () => {
    const isFs = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
    if (!isFs) {
      const el = document.documentElement;
      const req = el.requestFullscreen || (el as any).webkitRequestFullscreen;
      req?.call(el)?.catch?.(() => {});
    } else {
      const exit = document.exitFullscreen || (document as any).webkitExitFullscreen;
      exit?.call(document)?.catch?.(() => {});
    }
  };

  // ── Emoji send helper ─────────────────────────────────────────
  const sendEmoji = (emoji: string) => {
    const name = players[myIndex]?.name ?? playerName;
    socketRef.current?.emit("chatMessage", {
      roomId: roomIdRef.current,
      sender: name,
      text: `__emoji__${emoji}`,
    });
    // Show locally immediately
    const id = ++emojiIdRef.current;
    const x = 30 + Math.random() * 40;
    setEmojiReactions((prev) => [...prev, { id, name, emoji, x }]);
    setTimeout(() => setEmojiReactions((prev) => prev.filter((r) => r.id !== id)), 2500);
  };

  const handleEnterRooms = (asGuest = false) => {
    const name = playerName.trim();
    if (!name) return;
    setPlayerName(name);
    try { localStorage.setItem("speet-name", name); } catch { /* ignore */ }
    setIsGuestMode(asGuest);
    socketRef.current?.emit("getRooms");
    setPhase("rooms");
  };

  const initGameState = (pc: 4 | 6, rid: string) => {
    maxScoreRef.current = pc === 6 ? 36 : 54;
    minRoundScoreRef.current = 8;
    playerCountRef.current = pc;
    setPlayers(buildPlayers(pc));
    setSubmittedPurchases(new Array(pc).fill(null));
    setMyHand([]);
    setRoundPhase("dealing");
    setBotSeats(new Set());
    setPlayerLastBoughtRound(new Array(pc).fill(0));
    playerLastBoughtRoundRef.current = new Array(pc).fill(0);
    setForcedBuyPlayer(null);
    forcedBuyPlayerRef.current = null;
    roomIdRef.current = rid;
    setRoomId(rid);
  };

  const handleStartOffline = (pc: 4 | 6) => {
    const name = playerName.trim() || "لاعب";
    const roomId = `offline-${Date.now()}`;
    // Swap to offline socket BEFORE going to game phase
    const sock = createOfflineSocket();
    socketRef.current = sock;
    // Mirror claimed seats immediately so fillBots() sees the human
    const cs: Record<number, string> = { 0: name };
    setClaimedSeats(cs);
    claimedSeatsRef.current = cs;
    setMyIndex(0);
    myIndexRef.current = 0;
    setIsHost(true);
    isHostRef.current = true;
    setOfflineMode(true);
    setPlayerCount(pc);
    playerCountRef.current = pc;
    setStartMode("immediate");
    startModeRef.current = "immediate";
    initGameState(pc, roomId);
    setPhase("game");
  };

  const handleQuickMatch = (pc: 4 | 6) => {
    const name = playerName.trim();
    if (!name) return;
    setPlayerName(name);
    try { localStorage.setItem("speet-name", name); } catch { /* ignore */ }
    setQuickMatchLoading(true);
    setQuickPc(pc);
    socketRef.current?.emit("quickMatch", { playerCount: pc, playerName: name });
  };

  const handleCreateRoom = (mode: "wait" | "immediate") => {
    const name = playerName.trim();
    if (!name) return;
    const newRoomId = `hokm-${Date.now()}`;
    setStartMode(mode);
    startModeRef.current = mode;
    // Always start the host at seat 0 so joiners don't land on the same team
    setMyIndex(0);
    myIndexRef.current = 0;
    // Mirror the seat immediately so fillBots sees us before server responds
    claimedSeatsRef.current = { 0: name };
    setClaimedSeats({ 0: name });
    initGameState(playerCount, newRoomId);
    setBotCountdown(mode === "immediate" ? null : undefined as any);
    setPhase("game");
    const roomName = `لعبة ${name}`;
    setIsHost(true);
    isHostRef.current = true;
    socketRef.current?.emit("createRoom", { roomId: newRoomId, name: roomName, playerCount, playerName: name });
    socketRef.current?.emit("claimSeat", { roomId: newRoomId, index: 0, name });
  };

  const handleJoinExistingRoom = (targetRoomId: string, targetPlayerCount: number, status: string) => {
    const name = playerName.trim();
    if (!name) return;
    const pc = (targetPlayerCount === 6 ? 6 : 4) as 4 | 6;
    setPlayerCount(pc);
    setStartMode("wait");
    startModeRef.current = "wait";
    initGameState(pc, targetRoomId);
    setPhase("game");
    // Joining players are never the host
    setIsHost(false);
    isHostRef.current = false;
    if (status !== "playing") {
      pendingJoinRef.current = { roomId: targetRoomId, name };
    }
    socketRef.current?.emit("joinRoom", targetRoomId, name);
    // If status === "playing", wait for botSeatsList event → show seat-picker overlay
  };

  const handleJoin = () => {
    if (!playerName.trim()) {
      setNameShake(true);
      setTimeout(() => setNameShake(false), 500);
      nameInputRef.current?.focus();
      return;
    }
    handleEnterRooms(isGuestMode);
  };

  const handleJoinAsSpectator = (targetRoomId: string, targetPlayerCount: number) => {
    const name = playerName.trim();
    if (!name) return;
    const pc = (targetPlayerCount === 6 ? 6 : 4) as 4 | 6;
    setPlayerCount(pc);
    setIsSpectator(true);
    isSpectatorRef.current = true;
    initGameState(pc, targetRoomId);
    setPhase("game");
    socketRef.current?.emit("joinAsSpectator", { roomId: targetRoomId, name });
  };

  // Deal cards — host/anyone can trigger; purchasing starts immediately
  const handleDeal = () => {
    // Whoever clicks "Deal" becomes the host/game-master for this session.
    // Without this, allSubmitted never triggers handleNextRound() and the game freezes.
    if (!isHostRef.current) {
      setIsHost(true);
      isHostRef.current = true;
    }
    const seed = Math.floor(Math.random() * 2 ** 31);
    const hands = dealHands(playerCount, seed);
    // Store ALL player hands so host can play for bots AND offline players
    const bh: Record<number, CardStr[]> = {};
    const bp: Record<number, Set<CardStr>> = {};
    for (let i = 0; i < playerCount; i++) { bh[i] = [...hands[i]]; bp[i] = new Set(); }
    botHandsRef.current = bh;
    botPlayedRef.current = bp;
    allPlayedCardsRef.current = new Set();
    const localHand = hands[myIndex];
    setOriginalHand([...localHand]);
    setMyHand(sortHand(localHand));
    playDealSound();
    setInGameSession(true);
    setRoundPhase("purchasing");
    setMySubmitted(false);
    const allSeats = Array.from({ length: playerCount }, (_, i) => i);
    const initialSubmitted = new Array(playerCount).fill(null) as (number | null)[];

    // ── Forced-buy logic ─────────────────────────────────────
    let forced6Team: 0 | 1 | null = null;
    let forced4Player: number | null = null;

    // Per-player forced buy for both 4-player and 6-player:
    // If any player hasn't bought yet and we're at round ≥ 8, that player is forced.
    // Minimum bid: 8 for 4-player, 6 for 6-player.
    if (roundNumber >= 8) {
      const plbr = playerLastBoughtRoundRef.current;
      for (const seat of allSeats) {
        if (!plbr[seat]) { forced4Player = seat; break; }
      }
    }

    setForcedBuyTeam(forced6Team);
    forcedBuyTeamRef.current = forced6Team;
    setForcedBuyPlayer(forced4Player);
    forcedBuyPlayerRef.current = forced4Player;
    socketRef.current?.emit("forcedBuyTeamSet", { roomId: roomIdRef.current, team: forced6Team });
    socketRef.current?.emit("forcedBuyPlayerSet", { roomId: roomIdRef.current, player: forced4Player });

    // Auto-submit 0 for locked seats
    const forcedMinBid = playerCount === 4 ? 4 : 3;
    const normalMinBid = playerCount === 4 ? 2 : 1;
    if (forced4Player !== null) {
      allSeats.filter(s => s !== forced4Player).forEach(s => {
        initialSubmitted[s] = 0;
        socketRef.current?.emit("purchaseSubmit", { roomId: roomIdRef.current, index: s, value: 0 });
      });
      setMyDraft(myIndex === forced4Player ? forcedMinBid : normalMinBid);
    } else {
      setMyDraft(normalMinBid);
    }
    setSubmittedPurchases(initialSubmitted);

    // Compute purchase order: only include eligible seats
    const evens = Array.from({ length: Math.ceil(playerCount / 2) }, (_, i) => i * 2);
    const odds  = Array.from({ length: Math.floor(playerCount / 2) }, (_, i) => i * 2 + 1);
    const orderedAll: number[] =
      team1Score > team2Score ? [...evens, ...odds] :
      team2Score > team1Score ? [...odds, ...evens] :
      allSeats;
    const order = forced4Player !== null ? [forced4Player] : orderedAll;
    setPurchaseOrder(order);
    socketRef.current?.emit("dealCards", { roomId: roomIdRef.current, seed, playerCount });
    socketRef.current?.emit("startPurchasing", { roomId: roomIdRef.current });
    socketRef.current?.emit("purchaseOrderSet", { roomId: roomIdRef.current, order });
    socketRef.current?.emit("botSeatsUpdate", { roomId: roomIdRef.current, seats: Array.from(botSeatsRef.current) });
  };
  // Keep the ref in sync so the auto-start timer can always call the latest handleDeal
  handleDealRef.current = handleDeal;

  const handleSubmitPurchase = () => {
    if (mySubmitted || gameOver || purchaseTurn !== myIndex) return;
    const minBid = forcedBuyPlayer === myIndex ? (playerCount === 4 ? 4 : 3) : (playerCount === 4 ? 2 : 1);
    const val = Math.max(minBid, myDraft);
    setSubmittedPurchases((prev) => { const n = [...prev]; n[myIndex] = val; return n; });
    setMySubmitted(true);
    playBidSound();
    socketRef.current?.emit("purchaseSubmit", { roomId: roomIdRef.current, index: myIndex, value: val });
  };


  // ── Confirm bids → redeal check → start playing ───────────
  const handleNextRound = () => {
    if (gameOver) return;
    // Always read from ref so stale closures in the allSubmitted effect get fresh values
    const purchases = submittedPurchasesRef.current.map((v) => v ?? 0);
    // Alternating teams: even seats = العربي, odd = السد
    let t1 = purchases.filter((_, i) => i % 2 === 0).reduce((a, v) => a + v, 0);
    let t2 = purchases.filter((_, i) => i % 2 !== 0).reduce((a, v) => a + v, 0);
    const sumAll = t1 + t2;
    const limit = playerCount === 4 ? 10 : 6;

    if (prevTotalsRef.current.length < 2) {
      if (sumAll <= limit) {
        prevTotalsRef.current.push(sumAll);
        const log = "🔄 إعادة توزيع الورق – مجموع الشراء " + sumAll + " ورقة فقط";
        socketRef.current?.emit("roundReset", { roomId: roomIdRef.current, log });
        setRoundLog((prev) => [...prev, log]);
        setSubmittedPurchases(new Array(playerCount).fill(null));
        setMySubmitted(false); setMyDraft(playerCountRef.current === 4 ? 2 : 1); setMyHand([]); setRoundPhase("dealing");
        // Auto-redeal immediately so the game never freezes on host
        setTimeout(() => handleDealRef.current(), 600);
        return;
      } else prevTotalsRef.current.push(sumAll);
    } else if (prevTotalsRef.current.length >= 2 && sumAll <= limit) {
      const f = playerCount === 4 ? 5 : 4; t1 = f; t2 = f;
    }

    // ── لورنس: show notice then play (outcome decided after all tricks won/lost) ──
    const totalTricks = playerCount === 4 ? 13 : 9;
    if (t1 >= totalTricks || t2 >= totalTricks) {
      const lawrenceTeam = t1 >= totalTricks ? "العربي" : "السد";
      const log = "⚠️ لورنس! فريق " + lawrenceTeam + " اشترى " + totalTricks + " ورقة – الفوز أو الخسارة بالكامل!";
      setRoundLog((prev) => [...prev, log]);
    }

    // All good — start playing tricks
    handleStartPlaying();
  };
  // Keep ref fresh so the allSubmitted effect always calls the latest version
  handleNextRoundRef.current = handleNextRound;

  // ── Start playing phase ─────────────────────────────────────
  const handleStartPlaying = () => {
    const tricksTotal = playerCount === 4 ? 13 : 9;
    // First to play = first seat of the team that's ahead in points.
    // Even seats (0,2,4) = العربي (team1), odd seats (1,3,5) = السد (team2).
    // If tied or first round → seat 1 (first player to the right).
    const leader = team1Score > team2Score ? 0 : 1;
    totalTricksRef.current = tricksTotal;
    trickCardsRef.current = [];
    tricksWonRef.current = new Array(playerCount).fill(0);
    trickNumberRef.current = 0;
    trickLeaderRef.current = leader;
    currentTurnRef.current = leader;
    playingPhaseRef.current = true;
    blackJokerPlayedRef.current = false;
    blackJokerSeenBeforeTrickRef.current = false;
    setTrickCards([]);
    setTricksWon(new Array(playerCount).fill(0));
    setTrickNumber(0);
    setTrickLeader(leader);
    setCurrentTurn(leader);
    setLastTrickWinner(null);
    setBlackJokerPlayed(false);
    setLastTrickForfeited(false);
    roundStartTimeRef.current = Date.now();
    setRoundDuration(null);
    setPlayingPhase(true);
    setBidFlash(null);
    socketRef.current?.emit("startPlaying", { roomId: roomIdRef.current, leader, tricksTotal, playerCount });
  };

  // ── Play a card from my hand ────────────────────────────────
  const handlePlayCard = (card: CardStr) => {
    if (!playingPhase || gameOver) return;
    if (currentTurnRef.current !== myIndex) return;
    if (trickAnimating) return;
    const ledSuit = trickCardsRef.current.length > 0 ? cardSuit(trickCardsRef.current[0].card) : null;
    if (!validCards(myHandRef.current, ledSuit, blackJokerPlayedRef.current, trickCardsRef.current.some((e) => e.card === JOKER_B)).includes(card)) return;
    playCardSound();
    setMyHand((prev) => sortHand(prev.filter((c) => c !== card)));
    socketRef.current?.emit("cardPlayed", { roomId: roomIdRef.current, playerIndex: myIndex, card });
    applyCardRef.current(myIndex, card);
  };

  const finish = (t1: number, t2: number, log: string, w: string) => {
    const newLog = [...roundLog, log];
    setTeam1Score(t1); setTeam2Score(t2);
    setRoundLog(newLog); setRoundNumber((r) => r + 1);
    prevTotalsRef.current = []; // reset re-deal counter for the new round
    setSubmittedPurchases(new Array(playerCount).fill(null));
    setMySubmitted(false); setMyDraft(playerCountRef.current === 4 ? 2 : 1); setMyHand([]); setRoundPhase("dealing");
    socketRef.current?.emit("gameUpdate", { roomId: roomIdRef.current, team1Score: t1, team2Score: t2, roundNumber: roundNumber + 1, roundLog: newLog });
    if (w) { setWinner(w); setGameOver(true); }
  };

  const handleReset = (fromSocket = false) => {
    if (!fromSocket && isHost && socketRef.current) {
      socketRef.current.emit("restartGame", { roomId: roomIdRef.current });
    }
    // In offline mode, restart directly (keep bots and socket intact)
    if (offlineMode && !fromSocket) {
      const name = playerName.trim() || "لاعب";
      const pc = playerCountRef.current;
      const rid = `offline-${Date.now()}`;
      const cs: Record<number, string> = { 0: name };
      setClaimedSeats(cs);
      claimedSeatsRef.current = cs;
      setTeam1Score(0); setTeam2Score(0); setRoundNumber(0); setRoundLog([]);
      setGameOver(false); setWinner(""); setShowCelebration(false); prevTotalsRef.current = [];
      lawrenceAlertRef.current = null; setLawrenceAlert(null);
      setLastBuyRound([0, 0]); lastBuyRoundRef.current = [0, 0];
      setForcedBuyTeam(null); forcedBuyTeamRef.current = null;
      setForcedBuyPlayer(null); forcedBuyPlayerRef.current = null;
      setPlayerLastBoughtRound(new Array(pc).fill(0));
      playerLastBoughtRoundRef.current = new Array(pc).fill(0);
      setSubmittedPurchases(new Array(pc).fill(null));
      setMySubmitted(false); setMyDraft(pc === 4 ? 2 : 1); setMyHand([]); setRoundPhase("dealing");
      setBotCountdown(null); setPurchaseTimer(null);
      setPlayingPhase(false); setTrickCards([]); setTricksWon([]); setTrickNumber(0);
      setCurrentTurn(0); setTrickLeader(0); setLastTrickWinner(null); setTrickAnimating(false);
      setBlackJokerPlayed(false); setLastTrickForfeited(false);
      trickCardsRef.current = []; tricksWonRef.current = []; trickNumberRef.current = 0;
      playingPhaseRef.current = false; blackJokerPlayedRef.current = false;
      setLastTricksLog([]); setHintCard(null); setShowHint(false);
      setLastRoundSummary(null); setNextRoundCountdown(null);
      setGameStats({ tricksPerPlayer: [], trumpPerPlayer: [] });
      trumpPlaysThisRoundRef.current = [];
      setSweepBannerTeam(null); setFailBidBanner(null);
      setOriginalHand([]); setInGameSession(false);
      setOfflineSeats(new Set()); offlineSeatsRef.current = new Set();
      roomIdRef.current = rid;
      setRoomId(rid);
      // Re-fill bots after state flush then auto-deal
      setTimeout(() => {
        const newBots = new Set<number>();
        const newPlayers: { name: string }[] = [];
        for (let i = 0; i < pc; i++) {
          if (i === 0) {
            newPlayers.push({ name: name || `لاعب 1` });
          } else {
            const teamLabel = i % 2 === 0 ? "عرباوي" : "سداوي";
            const teamNum = Math.floor(i / 2) + 1;
            newPlayers.push({ name: `${teamLabel}${teamNum}` });
            newBots.add(i);
          }
        }
        botSeatsRef.current = newBots;
        setBotSeats(newBots);
        setPlayers(newPlayers);
        setTimeout(() => handleDealRef.current(), 50);
      }, 80);
      return;
    }
    setOfflineSeats(new Set());
    setHandSortMode("suit");
    setOriginalHand([]);
    setShowRoundHistory(false);
    setInGameSession(false);
    setTeam1Score(0); setTeam2Score(0); setRoundNumber(0); setRoundLog([]);
    setGameOver(false); setWinner(""); setShowCelebration(false); setOfflineMode(false); prevTotalsRef.current = [];
    lawrenceAlertRef.current = null; setLawrenceAlert(null);
    setLastBuyRound([0, 0]); lastBuyRoundRef.current = [0, 0];
    setForcedBuyTeam(null); forcedBuyTeamRef.current = null;
    setForcedBuyPlayer(null); forcedBuyPlayerRef.current = null;
    const pc = playerCountRef.current;
    setPlayerLastBoughtRound(new Array(pc).fill(0));
    playerLastBoughtRoundRef.current = new Array(pc).fill(0);
    // Preserve real player names; only use default bot names for unclaimed seats
    setPlayers(buildPlayers(playerCount).map((p, i) =>
      claimedSeatsRef.current[i] ? { name: claimedSeatsRef.current[i] } : p
    ));
    setSubmittedPurchases(new Array(playerCount).fill(null));
    setMySubmitted(false); setMyDraft(pc === 4 ? 2 : 1); setMyHand([]); setRoundPhase("dealing");
    setBotSeats(new Set()); setBotCountdown(null); setPurchaseTimer(null);
    setIsSpectator(false); isSpectatorRef.current = false; setSpectators([]);
    // Clear trick state
    setPlayingPhase(false); setTrickCards([]); setTricksWon([]); setTrickNumber(0);
    setCurrentTurn(0); setTrickLeader(0); setLastTrickWinner(null); setTrickAnimating(false);
    setBlackJokerPlayed(false); setLastTrickForfeited(false);
    trickCardsRef.current = []; tricksWonRef.current = []; trickNumberRef.current = 0;
    playingPhaseRef.current = false; blackJokerPlayedRef.current = false; blackJokerSeenBeforeTrickRef.current = false;
    // Reset new feature states
    setLastTricksLog([]); setHintCard(null); setShowHint(false);
    setLastRoundSummary(null); setNextRoundCountdown(null);
    // Reset stats features
    setGameStats({ tricksPerPlayer: [], trumpPerPlayer: [] });
    trumpPlaysThisRoundRef.current = [];
    setSweepBannerTeam(null); setFailBidBanner(null);
  };

  const handleExitGame = () => {
    const wasOffline = offlineMode;
    if (wasOffline) {
      // Offline socket is fake — disconnect it and reconnect to real server
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      const realSock = io(window.location.origin, { transports: ["websocket", "polling"] });
      socketRef.current = realSock;
      realSock.on("connect", () => { setConnected(true); realSock.emit("getRooms"); });
      realSock.on("disconnect", () => setConnected(false));
      realSock.on("roomList", (list: any[]) => { setActiveRooms(list); setRefreshingRooms(false); });
      realSock.on("roomsUpdate", (list: any[]) => { setActiveRooms(list); setRefreshingRooms(false); });
      realSock.on("playerJoined", (d: any) => setOnlinePlayers(d.playerCount));
      realSock.on("seatUpdate", (seats: Record<number, string>) => {
        claimedSeatsRef.current = { ...seats };
        setClaimedSeats({ ...seats });
        const pc = playerCountRef.current;
        if (pc > 0) {
          setPlayers(prev => {
            const n = prev.length === pc ? [...prev] : Array.from({ length: pc }, (_, i) => ({
              name: i % 2 === 0 ? `عرباوي ${Math.floor(i / 2) + 1}` : `سداوي ${Math.floor(i / 2) + 1}`,
            }));
            for (let i = 0; i < pc; i++) { if (seats[i]) n[i] = { name: seats[i] }; }
            return n;
          });
        }
        if (pendingJoinRef.current) {
          const { roomId, name } = pendingJoinRef.current;
          pendingJoinRef.current = null;
          const taken = Object.keys(seats).map(Number);
          let nextSeat = 0;
          for (let i = 0; i < pc; i++) { if (!taken.includes(i)) { nextSeat = i; break; } }
          setMyIndex(nextSeat); myIndexRef.current = nextSeat;
          setPlayers(prev => { const n = [...prev]; if (n[nextSeat]) n[nextSeat] = { name }; return n; });
          realSock.emit("claimSeat", { roomId, index: nextSeat, name });
        }
      });
    } else {
      // Online: keep the socket alive (all game handlers stay registered), just leave the room
      if (socketRef.current && roomIdRef.current) {
        socketRef.current.emit("leaveRoom", roomIdRef.current);
        socketRef.current.emit("getRooms");
      }
    }
    // Stop microphone
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      setMicOn(false);
    }
    // Full state reset
    claimedSeatsRef.current = {};
    setClaimedSeats({});
    handleReset();
    setRoomId(""); roomIdRef.current = "";
    setChatMessages([]); setChatOpen(false);
    setIsHost(false); setOnlinePlayers(0);
    // Only reset connection indicator if socket is actually gone (offline exit)
    if (offlineMode) setConnected(false);
    setIsGuestMode(false);
    // Go back to setup screen
    setPhase("setup");
  };

  const toggleMic = async () => {
    if (!micOn) {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          toast({ title: "المتصفح لا يدعم الميكروفون", description: "استخدم متصفحاً حديثاً مع HTTPS", variant: "destructive", duration: 4000 });
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStreamRef.current = stream;
        let pc = pcRef.current;
        if (!pc) {
          pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] });
          pcRef.current = pc;
          pc.onicecandidate = (e) => {
            if (e.candidate) socketRef.current?.emit("webrtcSignal", { candidate: e.candidate, roomId: roomIdRef.current });
          };
          pc.ontrack = (e) => {
            const a = document.createElement("audio");
            a.srcObject = e.streams[0]; a.autoplay = true;
            a.setAttribute("playsinline", "");
            document.body.appendChild(a);
            a.play().catch(() => {});
          };
        }
        stream.getTracks().forEach((t) => pc!.addTrack(t, stream));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current?.emit("webrtcSignal", { sdp: pc.localDescription, roomId: roomIdRef.current });
        setMicOn(true);
        toast({ title: "🎙️ الميكروفون يعمل", description: "أصبحت متصلاً صوتياً", duration: 2500 });
      } catch (err: any) {
        const name = (err as any)?.name ?? "";
        const msg = name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "تعذّر الوصول للميكروفون – امنح الإذن من إعدادات المتصفح"
          : name === "NotFoundError"
          ? "لم يُعثر على ميكروفون في جهازك"
          : "تعذّر تشغيل الميكروفون – تأكد من الاتصال عبر HTTPS";
        toast({ title: "خطأ في الميكروفون", description: msg, variant: "destructive", duration: 5000 });
      }
    } else {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null; pcRef.current?.close(); pcRef.current = null; setMicOn(false);
    }
  };

  const stopLobbyVoice = () => {
    lobbyStreamRef.current?.getTracks().forEach(t => t.stop());
    lobbyStreamRef.current = null;
    lobbyPcRef.current?.close();
    lobbyPcRef.current = null;
    setLobbyMicOn(false);
    socketRef.current?.emit("lobbyVoiceOff");
  };

  const toggleLobbyMic = async () => {
    if (!lobbyMicOn) {
      try {
        const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)
          || (navigator as any).getUserMedia?.bind(navigator)
          || (navigator as any).webkitGetUserMedia?.bind(navigator);
        if (!gum) {
          toast({ title: "المتصفح لا يدعم الميكروفون", variant: "destructive", duration: 3000 });
          return;
        }
        const stream: MediaStream = await (navigator.mediaDevices?.getUserMedia
          ? navigator.mediaDevices.getUserMedia({ audio: true })
          : new Promise<MediaStream>((res, rej) => (gum as Function)({ audio: true }, res, rej)));
        lobbyStreamRef.current = stream;
        const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
        lobbyPcRef.current = pc;
        stream.getTracks().forEach(t => pc.addTrack(t, stream));
        pc.onicecandidate = (e) => {
          if (e.candidate) socketRef.current?.emit("webrtcSignal", { candidate: e.candidate, roomId: "__lobby__", isLobby: true });
        };
        pc.ontrack = (e) => {
          const a = document.createElement("audio");
          a.srcObject = e.streams[0]; a.autoplay = true;
          a.setAttribute("playsinline", "");
          a.muted = lobbyAudioMuted;
          lobbyAudioElRef.current = a;
          document.body.appendChild(a);
          a.play().catch(() => {});
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current?.emit("webrtcSignal", { sdp: pc.localDescription, roomId: "__lobby__", isLobby: true });
        socketRef.current?.emit("lobbyVoiceOn");
        setLobbyMicOn(true);
      } catch {
        toast({ title: "تعذّر الوصول للميكروفون", description: "تأكد من منح الإذن في المتصفح", variant: "destructive", duration: 3000 });
      }
    } else {
      stopLobbyVoice();
    }
  };

  const sendChat = () => {
    if (!chatInput.trim()) return;
    const msg: ChatMsg = { sender: playerName || "أنت", text: chatInput.trim(), time: new Date().toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" }) };
    setChatMessages((prev) => [...prev, msg]);
    socketRef.current?.emit("chatMessage", { ...msg, roomId: roomIdRef.current });
    setChatInput("");
  };

  // Share room link
  const handleShareRoom = () => {
    const url = `${window.location.origin}?room=${roomIdRef.current}`;
    const copyFallback = () => {
      try {
        const el = document.createElement("textarea");
        el.value = url;
        el.style.position = "fixed";
        el.style.top = "-9999px";
        document.body.appendChild(el);
        el.focus();
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      } catch {}
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2500);
    };
    if (navigator.share) {
      navigator.share({ title: "حكم سبيت", text: "انضم للعبة!", url }).catch(() => copyFallback());
    } else if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url)
        .then(() => { setShareCopied(true); setTimeout(() => setShareCopied(false), 2500); })
        .catch(copyFallback);
    } else {
      copyFallback();
    }
  };

  // Toggle manual sort
  const toggleSort = () => {
    setIsSorted(prev => {
      const next = !prev;
      if (next) setMyHand(h => sortHand(h));
      return next;
    });
  };

  const maxScore = maxScoreRef.current;
  const isTeam1 = myIndex % 2 === 0; // alternating: even seats = العربي, odd = السد
  const submittedCount = submittedPurchases.filter((v) => v !== null).length;

  // ═══════════════════════ SETUP SCREEN ═══════════════════════
  if (phase === "setup") {
    return (
      <>
      <div className="game-fullheight felt-bg flex flex-col overflow-y-auto relative" style={{ overscrollBehavior: 'none', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
        <style>{`
          @-webkit-keyframes suitPulse{0%,100%{opacity:.65;-webkit-transform:scale(1);transform:scale(1)}50%{opacity:.9;-webkit-transform:scale(1.1);transform:scale(1.1)}}
          @keyframes suitPulse{0%,100%{opacity:.65;transform:scale(1)}50%{opacity:.9;transform:scale(1.1)}}
          .suit-anim{-webkit-animation:suitPulse 3s ease-in-out infinite;animation:suitPulse 3s ease-in-out infinite;}
          .suit-anim:nth-child(2){-webkit-animation-delay:.5s;animation-delay:.5s}
          .suit-anim:nth-child(3){-webkit-animation-delay:1s;animation-delay:1s}
          .suit-anim:nth-child(4){-webkit-animation-delay:1.5s;animation-delay:1.5s}
        `}</style>
        {floatPositions.map((f, i) => <FloatingCard key={i} {...f} />)}

        <div className="flex-1 flex flex-col justify-center w-full max-w-sm mx-auto px-4 relative z-10"
          style={{ paddingTop: 'max(12px, env(safe-area-inset-top, 12px))', paddingBottom: 'max(12px, env(safe-area-inset-bottom, 12px))' }}>

          {/* ── Single unified card ── */}
          <div className="rounded-2xl overflow-hidden shadow-2xl" style={{
            background: theme === 'light' ? 'rgba(248,246,240,0.97)' : 'rgba(22,22,30,0.95)',
            border: theme === 'light' ? '1px solid rgba(0,0,0,0.09)' : '1px solid rgba(255,255,255,0.08)',
            backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
            boxShadow: '0 10px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(176,128,64,0.1)'
          }}>

          {/* ── Header ── */}
          <div className="relative flex flex-col items-center pt-4 pb-3 px-4" style={{
            borderBottom: theme === 'light' ? '1px solid rgba(0,0,0,0.07)' : '1px solid rgba(255,255,255,0.06)'
          }}>
            {/* Settings button top-left */}
            <button data-testid="button-settings-lobby" onClick={() => setShowSettings(v => !v)}
              className="absolute top-3 left-3 w-8 h-8 rounded-full flex items-center justify-center transition-all"
              style={{ background: theme === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.07)', border: theme === 'light' ? '1px solid rgba(0,0,0,0.09)' : '1px solid rgba(255,255,255,0.1)' }}>
              <Settings className="w-4 h-4" style={{ color: theme === 'light' ? 'rgba(80,60,30,0.6)' : 'rgba(180,160,120,0.6)' }} />
            </button>
            {/* Suits row */}
            <div className="flex gap-2.5 text-2xl select-none mb-1">
              {SUITS_UI.map((s, i) => <span key={i} className={`suit-anim ${SUIT_COLORS[s]}`}>{s}</span>)}
            </div>
            {/* Title */}
            <h1 className="text-3xl font-black tracking-wide leading-none mb-0.5" style={{ color: '#b08040', textShadow: '0 1px 12px rgba(176,128,64,0.22)' }}>
              حكم سبيت
            </h1>
            {/* Connection */}
            <div className="flex items-center gap-1.5 mt-1">
              <div className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-rose-400"}`} />
              <span className="text-[11px]" style={{ color: theme === 'light' ? 'rgba(60,100,70,0.65)' : 'rgba(150,200,170,0.55)' }}>
                {connected ? `${onlinePlayers > 0 ? onlinePlayers + " " : ""}متصل` : "جارٍ الاتصال..."}
              </span>
            </div>
          </div>

          {/* ── Form section ── */}
          <div className="p-4 space-y-3">

            {/* Invite banner */}
            {quickJoinRoomId && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-amber-400/30 bg-amber-400/8">
                <span className="text-lg">📨</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold" style={{ color: '#b08040' }}>مدعو للانضمام</div>
                  <div className="text-[10px] text-white/40 truncate">{quickJoinRoomId}</div>
                </div>
              </div>
            )}

            {/* Name + icon row */}
            <div className="space-y-2">
              <Input ref={nameInputRef} data-testid="input-player-name"
                placeholder="اسمك... (مطلوب)" value={playerName}
                onChange={(e) => { setPlayerName(e.target.value); if (e.target.value.trim()) setNameShake(false); }}
                onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                autoComplete="nickname" enterKeyHint="go" inputMode="text"
                className={`text-right text-base font-semibold h-11 rounded-xl border-2 transition-all
                  ${theme === 'light'
                    ? "bg-white/80 text-foreground placeholder:text-foreground/30"
                    : "bg-black/30 text-[#c4b896] placeholder:text-white/20"}
                  ${!playerName.trim() ? "border-rose-500/50" : "border-amber-500/30 focus:border-amber-500/60"}
                  ${nameShake ? "input-shake" : ""}`}
                dir="rtl" />
              {/* Icon picker — single row */}
              <div className="flex gap-1 justify-between">
                {["♠","♥","♦","♣","🃏","⭐","🔥","👑","🎯","🦁"].map(icon => (
                  <button key={icon} data-testid={`button-icon-${icon}`} onClick={() => setPlayerIcon(icon)}
                    className={`flex-1 h-8 rounded-lg text-sm flex items-center justify-center transition-all ${
                      playerIcon === icon
                        ? "border-2 border-amber-400/90 bg-amber-400/20 scale-110 shadow-sm shadow-amber-400/20"
                        : theme === 'light'
                          ? "border border-border/30 bg-black/4 hover:bg-black/8"
                          : "border border-white/8 bg-white/4 hover:bg-white/10"
                    }`}>
                    {icon}
                  </button>
                ))}
              </div>
            </div>

            {/* PWA install banner */}
            {showInstallBanner && (
              <button onClick={async () => {
                  if (!deferredInstallPrompt) return;
                  deferredInstallPrompt.prompt();
                  const { outcome } = await deferredInstallPrompt.userChoice;
                  if (outcome === "accepted") setShowInstallBanner(false);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border border-[#b03050]/30 bg-[#b03050]/8 hover:bg-[#b03050]/14 transition-all text-right"
                data-testid="button-pwa-install">
                <span className="text-xl">📲</span>
                <div className="flex-1">
                  <div className="text-xs font-bold" style={{ color: '#b03050' }}>أضف التطبيق لشاشتك</div>
                  <div className="text-[10px]" style={{ color: '#c05070' }}>تثبيت للوصول السريع</div>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-full font-bold" style={{ background: 'rgba(176,48,80,0.18)', color: '#b03050' }}>تثبيت</span>
              </button>
            )}

            {/* ── Main join button ── */}
            <button data-testid="button-join-game"
              onClick={() => {
                if (!playerName.trim()) {
                  setNameShake(true);
                  setTimeout(() => setNameShake(false), 500);
                  nameInputRef.current?.focus();
                  return;
                }
                handleEnterRooms(false);
              }}
              className="w-full h-12 rounded-xl font-black text-base tracking-wide transition-all flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(135deg, #7a5a1e 0%, #b08040 50%, #7a5a1e 100%)', color: '#f5edd8', boxShadow: '0 4px 18px rgba(176,128,64,0.30)' }}>
              <Play className="w-5 h-5" />دخول للصالة
            </button>

            {/* ── Offline section ── */}
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl" style={{
              border: theme === 'light' ? '1px solid rgba(0,0,0,0.08)' : '1px solid rgba(255,255,255,0.07)',
              background: theme === 'light' ? 'rgba(0,0,0,0.025)' : 'rgba(255,255,255,0.03)',
            }}>
              <span className="text-lg flex-shrink-0">🤖</span>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold leading-tight" style={{ color: theme === 'light' ? 'rgba(60,60,80,0.8)' : 'rgba(200,195,185,0.8)' }}>بدون إنترنت</div>
                <div className="flex items-center gap-1.5 mt-1">
                  {([4, 6] as const).map(n => (
                    <button key={n} data-testid={`button-offline-pc-${n}`}
                      onClick={() => setOfflinePc(n)}
                      className="text-[11px] font-bold px-2.5 py-0.5 rounded-full transition-all"
                      style={{
                        background: offlinePc === n ? 'rgba(176,128,64,0.85)' : theme === 'light' ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.08)',
                        color: offlinePc === n ? '#f5edd8' : theme === 'light' ? 'rgba(60,60,80,0.6)' : 'rgba(180,175,165,0.6)',
                      }}>
                      {n} لاعبين
                    </button>
                  ))}
                </div>
              </div>
              <button data-testid="button-start-offline"
                onClick={() => {
                  if (!playerName.trim()) {
                    setNameShake(true);
                    setTimeout(() => setNameShake(false), 500);
                    nameInputRef.current?.focus();
                    return;
                  }
                  handleStartOffline(offlinePc);
                }}
                className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg font-bold text-xs transition-all"
                style={{
                  background: theme === 'light' ? 'rgba(60,120,60,0.12)' : 'rgba(100,200,100,0.12)',
                  border: theme === 'light' ? '1px solid rgba(60,120,60,0.25)' : '1px solid rgba(100,200,100,0.2)',
                  color: theme === 'light' ? 'rgba(50,120,50,0.9)' : 'rgba(120,220,120,0.85)',
                }}>
                <Play className="w-3 h-3" />ابدأ
              </button>
            </div>

            {/* Bottom row */}
            <div className="flex gap-2">
              <button data-testid="button-open-feedback"
                onClick={() => { setShowFeedback(true); setFeedbackSent(false); setFeedbackText(""); }}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs transition-all"
                style={{
                  border: theme === 'light' ? '1px solid rgba(0,0,0,0.09)' : '1px solid rgba(255,255,255,0.08)',
                  background: theme === 'light' ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.03)',
                  color: theme === 'light' ? 'rgba(80,80,100,0.6)' : 'rgba(160,155,145,0.6)',
                }}>
                <MessageCircle className="w-3.5 h-3.5" />ملاحظة
              </button>
              <button data-testid="button-toggle-rules"
                onClick={() => setShowRules(v => !v)}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs transition-all"
                style={{
                  border: theme === 'light' ? '1px solid rgba(0,0,0,0.09)' : '1px solid rgba(255,255,255,0.08)',
                  background: theme === 'light' ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.03)',
                  color: theme === 'light' ? 'rgba(80,80,100,0.6)' : 'rgba(160,155,145,0.6)',
                }}>
                <span className="text-sm leading-none">📖</span>القوانين
              </button>
            </div>
          </div>
          </div>
        </div>

        {/* ── Settings Panel (lobby) ── */}
        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={() => setShowSettings(false)}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div className="relative w-full max-w-sm rounded-t-2xl border border-white/10 shadow-2xl overflow-y-auto"
              style={{ background: 'linear-gradient(180deg,#1a1a2e 0%,#0f0f1a 100%)', maxHeight: '85vh', paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}
              onClick={(e) => e.stopPropagation()}>
              <div className="p-5 space-y-4">
                <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mb-1" />
                <h2 className="text-sm font-bold text-white/90 text-center flex items-center justify-center gap-2">
                  <Settings className="w-4 h-4 text-primary" /> الإعدادات
                </h2>
                {([
                  { icon: <Volume2 className="w-4 h-4" />, label: "الصوت", desc: "أصوات اللعبة والتنبيهات", value: soundEnabled, toggle: () => setSoundEnabled(v => !v), testId: "setting-sound-lobby" },
                  { icon: <Vibrate className="w-4 h-4" />, label: "الاهتزاز", desc: "اهتزاز عند حلول دورك", value: vibrationEnabled, toggle: () => setVibrationEnabled(v => !v), testId: "setting-vibration-lobby" },
                  { icon: <Lightbulb className="w-4 h-4" />, label: "تلميح تلقائي", desc: "يظهر التلميح عند دورك", value: autoHint, toggle: () => setAutoHint(v => !v), testId: "setting-autohint-lobby" },
                ] as const).map((s) => (
                  <div key={s.testId} className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
                    <div className="flex items-center gap-2.5">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${s.value ? "bg-primary/20 text-primary" : "bg-white/5 text-white/30"}`}>{s.icon}</div>
                      <div>
                        <div className="text-sm font-semibold text-white/90">{s.label}</div>
                        <div className="text-[10px] text-white/40">{s.desc}</div>
                      </div>
                    </div>
                    <button data-testid={s.testId} onClick={s.toggle}
                      className={`relative w-12 h-6 rounded-full transition-all duration-300 flex-shrink-0 ${s.value ? "bg-primary" : "bg-white/10"}`}>
                      <div className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all duration-300 ${s.value ? "right-1" : "left-1"}`} />
                    </button>
                  </div>
                ))}
                {/* Color blind mode */}
                <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
                  <div className="flex items-center gap-2.5">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${colorBlindMode ? "bg-blue-500/20 text-blue-400" : "bg-white/5 text-white/30"}`}><span className="text-sm">♦</span></div>
                    <div>
                      <div className="text-sm font-semibold text-white/90">وضع عمى الألوان</div>
                      <div className="text-[10px] text-white/40">تمييز ♦ بلون أزرق عن ♥</div>
                    </div>
                  </div>
                  <button data-testid="setting-colorblind-lobby" onClick={() => setColorBlindMode(v => !v)}
                    className={`relative w-12 h-6 rounded-full transition-all duration-300 flex-shrink-0 ${colorBlindMode ? "bg-blue-500" : "bg-white/10"}`}>
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all duration-300 ${colorBlindMode ? "right-1" : "left-1"}`} />
                  </button>
                </div>
                {/* Animation speed */}
                <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/5 text-white/30"><Timer className="w-4 h-4" /></div>
                    <div>
                      <div className="text-sm font-semibold text-white/90">سرعة الحركة</div>
                      <div className="text-[10px] text-white/40">سرعة أنيميشن الكروت</div>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {(["fast","normal","slow"] as const).map((s) => (
                      <button key={s} data-testid={`setting-animspeed-lobby-${s}`} onClick={() => setAnimSpeed(s)}
                        className={`px-2 py-1 rounded-md text-[10px] font-bold border transition-all ${animSpeed === s ? "border-primary/60 bg-primary/20 text-primary" : "border-white/10 text-white/30"}`}>
                        {s === "fast" ? "سريع" : s === "normal" ? "عادي" : "بطيء"}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Card size */}
                <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/5 text-white/30"><CreditCard className="w-4 h-4" /></div>
                    <div>
                      <div className="text-sm font-semibold text-white/90">حجم الكروت</div>
                      <div className="text-[10px] text-white/40">حجم الكروت في يدك</div>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {(["sm", "md", "lg"] as const).map((s) => (
                      <button key={s} data-testid={`setting-cardsize-lobby-${s}`} onClick={() => setCardSizePref(s)}
                        className={`px-2 py-1 rounded-md text-[10px] font-bold border transition-all ${cardSizePref === s ? "border-primary/60 bg-primary/20 text-primary" : "border-white/10 text-white/30"}`}>
                        {s === "sm" ? "صغير" : s === "md" ? "متوسط" : "كبير"}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Theme */}
                <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
                  <div className="flex items-center gap-2.5">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${theme === "light" ? "bg-amber-400/20 text-amber-400" : "bg-indigo-500/20 text-indigo-300"}`}>
                      {theme === "light" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-white/90">مظهر التطبيق</div>
                      <div className="text-[10px] text-white/40">{theme === "light" ? "وضع النهار" : "وضع الليل"}</div>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button data-testid="setting-theme-dark-lobby" onClick={() => setTheme("dark")}
                      className={`px-2.5 py-1 rounded-md text-[10px] font-bold border transition-all flex items-center gap-1 ${theme === "dark" ? "border-indigo-400/60 bg-indigo-500/20 text-indigo-300" : "border-white/10 text-white/30"}`}>
                      <Moon className="w-3 h-3" /> داكن
                    </button>
                    <button data-testid="setting-theme-light-lobby" onClick={() => setTheme("light")}
                      className={`px-2.5 py-1 rounded-md text-[10px] font-bold border transition-all flex items-center gap-1 ${theme === "light" ? "border-amber-400/60 bg-amber-400/20 text-amber-400" : "border-white/10 text-white/30"}`}>
                      <Sun className="w-3 h-3" /> فاتح
                    </button>
                  </div>
                </div>
                {/* Table theme */}
                <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/5 text-white/30">
                      <Palette className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-white/90">لون الطاولة</div>
                      <div className="text-[10px] text-white/40">اختر لون البساط</div>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    {([
                      { id: "green",  bg: "bg-emerald-700",  ring: "ring-emerald-400" },
                      { id: "blue",   bg: "bg-sky-700",      ring: "ring-sky-400" },
                      { id: "purple", bg: "bg-purple-700",   ring: "ring-purple-400" },
                      { id: "brown",  bg: "bg-amber-900",    ring: "ring-amber-600" },
                    ] as { id: "green"|"blue"|"purple"|"brown"; bg: string; ring: string }[]).map((t) => (
                      <button key={t.id} data-testid={`setting-tabletheme-lobby-${t.id}`}
                        onClick={() => setTableTheme(t.id)}
                        className={`w-6 h-6 rounded-full ${t.bg} transition-all ${tableTheme === t.id ? `ring-2 ring-offset-1 ring-offset-zinc-900 ${t.ring} scale-110` : "opacity-50 hover:opacity-80"}`} />
                    ))}
                  </div>
                </div>
                {/* Table shape (4-player only) */}
                {playerCount !== 6 && (
                  <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/5 text-white/30">
                        <Hexagon className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-white/90">شكل الطاولة</div>
                        <div className="text-[10px] text-white/40">مستطيل أو بيضاوي</div>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <button data-testid="setting-tableshape-lobby-rect" onClick={() => setTableShape("rect")}
                        className={`px-2.5 py-1 rounded-md text-[10px] font-bold border transition-all ${tableShape === 'rect' ? 'border-rose-400/60 bg-rose-500/15 text-rose-300' : 'border-white/10 text-white/30 hover:border-white/25'}`}>
                        مستطيل
                      </button>
                      <button data-testid="setting-tableshape-lobby-oval" onClick={() => setTableShape("oval")}
                        className={`px-2.5 py-1 rounded-md text-[10px] font-bold border transition-all ${tableShape === 'oval' ? 'border-rose-400/60 bg-rose-500/15 text-rose-300' : 'border-white/10 text-white/30 hover:border-white/25'}`}>
                        بيضاوي
                      </button>
                    </div>
                  </div>
                )}
                <button onClick={() => setShowSettings(false)} className="w-full py-2 text-xs text-white/40 hover:text-white/70 transition-colors">
                  إغلاق
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Feedback modal ────────────────────────────────────── */}
      {showFeedback && (
        <div className="fixed inset-0 z-[500] flex items-center justify-center p-4" dir="rtl"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowFeedback(false); }}>
          <div className="w-full max-w-sm rounded-2xl border border-white/10 p-5 space-y-4 shadow-2xl"
            style={{ background: 'rgba(18,28,20,0.98)' }}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-emerald-400" />
                ملاحظة للإدارة
              </h2>
              <button onClick={() => setShowFeedback(false)}
                className="w-7 h-7 rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-all">
                <X className="w-4 h-4" />
              </button>
            </div>

            {feedbackSent ? (
              <div className="flex flex-col items-center gap-3 py-6">
                <CheckCircle2 className="w-12 h-12 text-emerald-400" />
                <p className="text-white font-semibold text-center">تم إرسال ملاحظتك</p>
                <p className="text-white/50 text-xs text-center">شكراً على تواصلك مع الإدارة</p>
                <button onClick={() => setShowFeedback(false)}
                  className="mt-2 px-6 py-2 rounded-xl text-sm font-bold text-white border border-emerald-500/50 bg-emerald-500/15 hover:bg-emerald-500/25 transition-all">
                  إغلاق
                </button>
              </div>
            ) : (
              <>
                <p className="text-white/50 text-xs leading-relaxed">
                  هل لديك اقتراح أو مشكلة؟ اكتب ملاحظتك وستصل مباشرة للإدارة.
                </p>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-white/60 uppercase tracking-wider">اسمك (اختياري)</label>
                  <Input
                    data-testid="input-feedback-name"
                    placeholder="اسمك أو بدون..."
                    defaultValue={playerName.trim() || ""}
                    readOnly
                    className="text-right text-sm h-9 rounded-xl bg-black/30 text-[#c4b896] border-white/10 placeholder:text-white/20"
                    dir="rtl"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-white/60 uppercase tracking-wider">الملاحظة</label>
                  <textarea
                    data-testid="input-feedback-text"
                    placeholder="اكتب ملاحظتك هنا..."
                    value={feedbackText}
                    onChange={(e) => setFeedbackText(e.target.value)}
                    rows={4}
                    maxLength={500}
                    className="w-full rounded-xl px-3 py-2.5 text-sm text-right text-[#c4b896] placeholder:text-white/20 border border-white/10 bg-black/30 resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                    dir="rtl"
                  />
                  <div className="text-left text-[10px] text-white/30">{feedbackText.length}/500</div>
                </div>
                <button
                  data-testid="button-send-feedback"
                  disabled={!feedbackText.trim()}
                  onClick={() => {
                    if (!feedbackText.trim()) return;
                    const name = playerName.trim() || "زائر";
                    socketRef.current?.emit("playerFeedback", { name, text: feedbackText.trim(), ts: Date.now() });
                    setFeedbackSent(true);
                    setFeedbackText("");
                  }}
                  className="w-full h-11 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: feedbackText.trim() ? 'linear-gradient(135deg,#065f46,#10b981)' : 'rgba(255,255,255,0.05)', color: '#fff', border: '1px solid rgba(16,185,129,0.4)' }}>
                  <Send className="w-4 h-4" />
                  إرسال الملاحظة
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Rules overlay ──────────────────────────────────────── */}
      {showRules && (
        <div className="fixed inset-0 z-[500] flex items-end justify-center" dir="rtl"
          style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowRules(false); }}>
          <div className="relative w-full max-w-sm rounded-t-2xl border border-white/10 overflow-y-auto shadow-2xl"
            style={{ background: 'linear-gradient(180deg,#141e16 0%,#0c130e 100%)', maxHeight: '88vh', paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
            <div className="sticky top-0 z-10 px-4 py-3 border-b border-white/8 flex items-center justify-between"
              style={{ background: '#141e16' }}>
              <h2 className="text-sm font-bold text-white/90 flex items-center gap-2">
                <span>📖</span>طريقة اللعب والقوانين
              </h2>
              <button onClick={() => setShowRules(false)}
                className="w-7 h-7 rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-all">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="text-right">
              <div className="px-4 py-3 border-b border-white/8">
                <h3 className="text-xs font-bold text-yellow-400 mb-2">🎯 شرط الفوز</h3>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-2 text-center">
                    <div className="text-yellow-300 text-xs font-bold">4 لاعبين</div>
                    <div className="text-white text-lg font-black">54</div>
                    <div className="text-[10px] text-muted-foreground">نقطة</div>
                  </div>
                  <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-2 text-center">
                    <div className="text-yellow-300 text-xs font-bold">6 لاعبين</div>
                    <div className="text-white text-lg font-black">36</div>
                    <div className="text-[10px] text-muted-foreground">نقطة</div>
                  </div>
                </div>
              </div>
              <div className="px-4 py-3 border-b border-white/8">
                <h3 className="text-xs font-bold text-yellow-400 mb-2">👥 الفرق</h3>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-xs bg-red-500/10 rounded-lg px-2.5 py-1.5">
                    <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                    <span><strong className="text-red-400">فريق العربي</strong> — المقاعد 1 · 3 · 5</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs bg-sky-500/10 rounded-lg px-2.5 py-1.5">
                    <span className="w-2 h-2 rounded-full bg-sky-400 shrink-0" />
                    <span><strong className="text-sky-400">فريق السد</strong> — المقاعد 2 · 4 · 6</span>
                  </div>
                </div>
              </div>
              <div className="px-4 py-3 border-b border-white/8">
                <h3 className="text-xs font-bold text-yellow-400 mb-2">♠ الحكم والجوكر</h3>
                <ul className="text-xs text-muted-foreground space-y-1.5 leading-relaxed">
                  <li className="flex gap-2"><span className="text-yellow-500 shrink-0">•</span><span>الحكم <strong className="text-white">البستوني ♠ ثابت دائماً</strong> — يقطع أي لون آخر.</span></li>
                  <li className="flex gap-2"><span className="text-yellow-500 shrink-0">•</span><span>الجوكر الأسود أعلى من الجوكر الأحمر، وكلاهما من الحكم ♠.</span></li>
                  <li className="flex gap-2"><span className="text-yellow-500 shrink-0">•</span><span>الجوكر الأحمر <strong className="text-white">لا يُفتح بيده</strong> حتى يُكسر الحكم.</span></li>
                  <li className="flex gap-2"><span className="text-yellow-500 shrink-0">•</span><span>الجوكر الأسود يُطبّق على الأكلة وينهيها فوراً.</span></li>
                </ul>
              </div>
              <div className="px-4 py-3 border-b border-white/8">
                <h3 className="text-xs font-bold text-yellow-400 mb-2">💰 الشراء (المزايدة)</h3>
                <ul className="text-xs text-muted-foreground space-y-1.5 leading-relaxed">
                  <li className="flex gap-2"><span className="text-yellow-500 shrink-0">•</span><span>الحد الأدنى <strong className="text-white">2</strong> في 4 لاعبين · <strong className="text-white">1</strong> في 6 لاعبين.</span></li>
                  <li className="flex gap-2"><span className="text-yellow-500 shrink-0">•</span><span>المزايدة تتصاعد: لا يمكنك المزايدة بأقل من السابق.</span></li>
                  <li className="flex gap-2"><span className="text-yellow-500 shrink-0">•</span><span><strong className="text-yellow-300">شراء مجبر ⚠️</strong> بعد جولة 8 بحد <strong className="text-white">8</strong> أو <strong className="text-white">6</strong>.</span></li>
                  <li className="flex gap-2"><span className="text-yellow-500 shrink-0">•</span><span><strong className="text-yellow-300">لورنس ⚡</strong> — المزايدة على جميع الأوراق، وينتهي دور الشراء فوراً للباقين.</span></li>
                  <li className="flex gap-2"><span className="text-yellow-500 shrink-0">•</span><span>فريق اللورنس <strong className="text-white">يجب أن يأكل جميع الأوراق</strong> للفوز — الفوز = الفوز باللعبة كاملةً فوراً.</span></li>
                  <li className="flex gap-2"><span className="text-red-400 shrink-0">•</span><span>إذا أكل الخصم <strong className="text-red-300">أكلة واحدة فقط</strong> — تنتهي اللعبة فوراً بخسارة فريق اللورنس.</span></li>
                </ul>
              </div>
              <div className="px-4 py-3 border-b border-white/8">
                <h3 className="text-xs font-bold text-yellow-400 mb-2">🃏 قواعد اللعب</h3>
                <ul className="text-xs text-muted-foreground space-y-1.5 leading-relaxed">
                  <li className="flex gap-2"><span className="text-yellow-500 shrink-0">•</span><span>الفائز بالمزايدة يبدأ أول أكلة.</span></li>
                  <li className="flex gap-2"><span className="text-yellow-500 shrink-0">•</span><span>يجب اللعب بنفس لون البادئ إن كان في يدك.</span></li>
                  <li className="flex gap-2"><span className="text-yellow-500 shrink-0">•</span><span>إن لم يكن معك اللون، القطع بالحكم ♠ أو رمي أي ورقة.</span></li>
                  <li className="flex gap-2"><span className="text-yellow-500 shrink-0">•</span><span>الأعلى قيمةً في لون البادئ تفوز — إلا إن قُطعت بحكم.</span></li>
                </ul>
              </div>
              <div className="px-4 py-3 border-b border-white/8">
                <h3 className="text-xs font-bold text-yellow-400 mb-2">🏆 حساب النقاط</h3>
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-2 text-center">
                      <div className="text-green-400 text-xs font-bold">حقّق المزايدة ✓</div>
                      <div className="text-green-300 text-xs mt-0.5">+ عدد الأكلات الفعلية</div>
                    </div>
                    <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-center">
                      <div className="text-red-400 text-xs font-bold">لم يحقق المزايدة ✗</div>
                      <div className="text-red-300 text-xs mt-0.5">− قيمة الطلعة فقط</div>
                    </div>
                  </div>
                  <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-xs text-blue-300">
                    <strong>بونص الكنة 🧹</strong> — جميع الأكلات = <strong>+2 نقطة إضافية</strong>
                  </div>
                  <div className="text-[10px] text-muted-foreground">مثال: نتيجتك 26 وشريت 6 وخسرت → 26 − 6 = <strong className="text-red-400">20</strong></div>
                </div>
              </div>
              <div className="px-4 py-3">
                <h3 className="text-xs font-bold text-yellow-400 mb-2">💡 نصائح</h3>
                <ul className="text-xs text-muted-foreground space-y-1.5 leading-relaxed">
                  <li className="flex gap-2"><span className="text-blue-400 shrink-0">↑↓</span><span>زر الترتيب يرتّب كروتك حسب الحكم واللون.</span></li>
                  <li className="flex gap-2"><span className="text-blue-400 shrink-0">💡</span><span>زر التلميح يقترح أفضل ورقة في دورك.</span></li>
                  <li className="flex gap-2"><span className="text-blue-400 shrink-0">🕐</span><span>زر الأكلة الأخيرة يعرض آخر أكلة انتهت.</span></li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
      </>
    );
  }

  // ═══════════════════════ ROOMS SCREEN ════════════════════════
  if (phase === "rooms") {
    const now = Date.now();
    const fmtAge = (ts: number) => {
      const s = Math.floor((now - ts) / 1000);
      if (s < 60) return `منذ ${s}ث`;
      const m = Math.floor(s / 60);
      return `منذ ${m}د`;
    };
    return (
      <div className="min-h-screen felt-bg flex items-start sm:items-center justify-center p-4 py-6 relative overflow-y-auto" dir="rtl">
        <style>{`@-webkit-keyframes floatCard{0%,100%{-webkit-transform:translateY(0)rotate(0);transform:translateY(0)rotate(0);opacity:.08}50%{-webkit-transform:translateY(-30px)rotate(10deg);transform:translateY(-30px)rotate(10deg);opacity:.15}}@keyframes floatCard{0%,100%{transform:translateY(0)rotate(0);opacity:.08}50%{transform:translateY(-30px)rotate(10deg);opacity:.15}}`}</style>
        {floatPositions.map((f, i) => <FloatingCard key={i} {...f} />)}

        {/* ── Incoming invite notification (rooms phase) ── */}
        {incomingInvite && (
          <div className="fixed inset-x-4 z-[999] flex justify-center" style={{ top: '1rem' }} dir="rtl">
            <div className="bg-zinc-900/97 border border-amber-500/60 rounded-2xl px-5 py-4 shadow-2xl backdrop-blur-sm flex flex-col gap-3 w-full max-w-sm slide-up">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                  <Users className="w-4 h-4 text-amber-400" />
                </div>
                <div>
                  <p className="text-sm font-bold text-foreground">دعوة للعب!</p>
                  <p className="text-xs text-muted-foreground">
                    <span className="text-amber-400 font-semibold">{incomingInvite.inviterName}</span> دعاك للعب معه
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground bg-muted/20 rounded-lg px-3 py-1.5">
                غرفة: <span className="text-foreground font-medium">{incomingInvite.roomName}</span> · {incomingInvite.playerCount} لاعبين
              </p>
              <div className="flex gap-2">
                <Button
                  data-testid="button-rooms-invite-accept"
                  size="sm"
                  className="flex-1 h-8 bg-green-600 hover:bg-green-700 text-white font-bold"
                  onClick={() => {
                    const pc = (incomingInvite.playerCount === 6 ? 6 : 4) as 4 | 6;
                    let name = playerName.trim() || "لاعب";
                    try { name = localStorage.getItem("speet-name") || name; } catch { /* ignore */ }
                    setPlayerCount(pc);
                    setStartMode("wait");
                    startModeRef.current = "wait";
                    initGameState(pc, incomingInvite.roomId);
                    setPhase("game");
                    setIsHost(false);
                    isHostRef.current = false;
                    pendingJoinRef.current = { roomId: incomingInvite.roomId, name };
                    socketRef.current?.emit("joinRoom", incomingInvite.roomId, name);
                    setIncomingInvite(null);
                  }}
                >
                  ✓ قبول
                </Button>
                <Button
                  data-testid="button-rooms-invite-decline"
                  size="sm"
                  variant="outline"
                  className="flex-1 h-8 border-border/40 text-muted-foreground hover:text-foreground"
                  onClick={() => setIncomingInvite(null)}
                >
                  رفض
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="w-full max-w-lg relative z-10 space-y-3">

          {/* ── Top bar ── */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex gap-1 text-lg select-none">
                {SUITS_UI.map((s, i) => <span key={i} className={`${SUIT_COLORS[s]} drop-shadow`}>{s}</span>)}
              </div>
              <div>
                <h1 className="text-base font-bold gold-text leading-tight">حكم سبيت</h1>
                <p className="text-[11px] text-muted-foreground leading-tight">
                  {playerName}
                  {(sessionStats.wins + sessionStats.losses) > 0 && (
                    <span className="mr-1.5">
                      <span className="text-green-400">✓{sessionStats.wins}</span>
                      <span className="mx-1 opacity-30">|</span>
                      <span className="text-rose-400">✗{sessionStats.losses}</span>
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <div className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
                <span>{onlinePlayers > 0 ? `${onlinePlayers} متصل` : connected ? "متصل" : "..."}</span>
              </div>
              <button onClick={() => setPhase("setup")} className="text-[11px] text-muted-foreground hover:text-foreground transition-colors border border-border/30 rounded-md px-2 py-1">← الاسم</button>
            </div>
          </div>

          {/* ── Quick-play card ── */}
          <Card className="border-border/50 shadow-xl overflow-hidden">
            <CardContent className="p-4 space-y-3">

              {/* Mode tabs — 4 or 6 players */}
              <div className="flex gap-2">
                {([4, 6] as const).map((n) => {
                  const active = playerCount === n;
                  return (
                    <button key={n} data-testid={`button-player-count-${n}`}
                      onClick={() => { setIsGuestMode(false); setPlayerCount(n); setMyIndex(0); }}
                      className={`flex-1 py-3 rounded-xl border-2 text-sm font-bold transition-all ${active
                        ? "bg-primary/15 border-primary text-primary shadow-sm shadow-primary/20"
                        : "bg-muted/20 border-border/30 text-muted-foreground hover:border-border/60 hover:bg-muted/40"}`}>
                      {n} لاعبين
                    </button>
                  );
                })}
              </div>

              {/* Start button */}
              <button
                data-testid="button-start-game"
                disabled={quickMatchLoading}
                onClick={() => handleQuickMatch(playerCount)}
                className="w-full py-4 rounded-xl font-black text-lg tracking-wide transition-all disabled:opacity-60 flex items-center justify-center gap-2"
                style={{ background: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)', color: '#fff', boxShadow: '0 4px 16px rgba(22,163,74,0.35)' }}
              >
                {quickMatchLoading ? (
                  <>
                    <span className="animate-spin text-xl">⟳</span>
                    <span className="text-base font-bold">جارٍ البحث عن لعبة...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5" />
                    <span>ابدأ اللعبة</span>
                  </>
                )}
              </button>
            </CardContent>
          </Card>

          {/* ── Lobby Chat ── */}
          <Card className="border-border/50 shadow-xl overflow-hidden">
            <button
              data-testid="button-lobby-chat-toggle"
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors"
              onClick={() => setLobbyChatOpen(v => !v)}
            >
              <div className="flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-primary" />
                <span className="font-semibold text-sm text-foreground">دردشة الصالة</span>
                {lobbyMessages.length > 0 && !lobbyChatOpen && (
                  <span className="bg-primary text-primary-foreground text-[10px] font-bold rounded-full px-1.5 py-0.5 leading-none">
                    {lobbyMessages.length > 99 ? "99+" : lobbyMessages.length}
                  </span>
                )}
                {lobbyVoiceUsers.length > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 px-1.5 py-0.5 rounded-full">
                    <Mic className="w-2.5 h-2.5 animate-pulse" />{lobbyVoiceUsers.length}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  {lobbyPlayers.length} متصل
                </span>
                {!isGuestMode && (
                  <button
                    data-testid="button-lobby-mic"
                    onClick={(e) => { e.stopPropagation(); toggleLobbyMic(); }}
                    title={lobbyMicOn ? "إيقاف الميكروفون" : "تشغيل الميكروفون"}
                    className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-bold transition-all ${
                      lobbyMicOn
                        ? "bg-green-500/20 text-green-400 border border-green-500/40 animate-pulse"
                        : "bg-muted/30 text-muted-foreground border border-border/30 hover:bg-muted/50"
                    }`}
                  >
                    {lobbyMicOn ? <Mic className="w-3 h-3" /> : <MicOff className="w-3 h-3" />}
                    <span>{lobbyMicOn ? "مفتوح" : "صوت"}</span>
                  </button>
                )}
                <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${lobbyChatOpen ? "-rotate-90" : "rotate-90"}`} />
              </div>
            </button>

            {lobbyChatOpen && (
              <div className="border-t border-border/30">
                {/* Voice users + mute */}
                {lobbyVoiceUsers.length > 0 && (
                  <div className="px-4 py-2 bg-green-500/5 border-b border-green-500/15 flex items-center gap-2 flex-wrap">
                    <Mic className="w-3 h-3 text-green-400 flex-shrink-0 animate-pulse" />
                    <span className="text-[11px] text-green-400 font-medium flex-1">في المحادثة الصوتية:</span>
                    {lobbyVoiceUsers.map((name, i) => (
                      <span key={i} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-green-500/15 border border-green-500/30 text-green-300">
                        🎙 {name}
                      </span>
                    ))}
                    <button
                      data-testid="button-lobby-mute-speakers"
                      title={lobbyAudioMuted ? "تشغيل صوت المتحدثين" : "كتم صوت المتحدثين"}
                      onClick={() => {
                        const next = !lobbyAudioMuted;
                        setLobbyAudioMuted(next);
                        if (lobbyAudioElRef.current) lobbyAudioElRef.current.muted = next;
                      }}
                      className={`flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full border transition-all ${
                        lobbyAudioMuted
                          ? "bg-red-500/20 border-red-500/50 text-red-400 hover:bg-red-500/30"
                          : "bg-green-500/10 border-green-500/30 text-green-400 hover:bg-green-500/20"
                      }`}>
                      {lobbyAudioMuted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                    </button>
                  </div>
                )}

                {/* Online players pills */}
                {lobbyPlayers.length > 0 && (
                  <div className="px-4 py-2 bg-muted/5 border-b border-border/15 flex gap-1.5 flex-wrap">
                    {lobbyPlayers.map((p) => (
                      <span key={p.socketId} data-testid={`badge-lobby-player-${p.socketId}`}
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-muted/40 border border-border/30 text-muted-foreground">
                        <div className={`w-1.5 h-1.5 rounded-full ${lobbyVoiceUsers.includes(p.name) ? "bg-green-400 animate-pulse" : "bg-muted-foreground/40"}`} />
                        {p.name}
                        {lobbyVoiceUsers.includes(p.name) && <Mic className="w-2.5 h-2.5 text-green-400" />}
                      </span>
                    ))}
                  </div>
                )}

                {/* Messages */}
                <div className="h-44 overflow-y-auto px-4 py-2 space-y-1.5 bg-muted/5">
                  {lobbyMessages.length === 0 && (
                    <p className="text-center text-muted-foreground text-xs py-6">لا توجد رسائل — كن أول من يتحدث!</p>
                  )}
                  {lobbyMessages.map((m, i) => {
                    const isMe = m.name === (playerName || "لاعب");
                    return (
                      <div key={i} className="flex gap-1.5">
                        <span className={`text-[11px] font-bold shrink-0 ${isMe ? "text-primary" : "text-amber-400"}`}>{m.name}:</span>
                        <span className="text-xs text-foreground break-words min-w-0">{m.text}</span>
                      </div>
                    );
                  })}
                  <div ref={lobbyMsgEndRef} />
                </div>

                {!isGuestMode && (
                  <div className="flex gap-2 p-3 border-t border-border/20">
                    <Input
                      data-testid="input-lobby-chat"
                      value={lobbyChatInput}
                      onChange={e => setLobbyChatInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && lobbyChatInput.trim()) {
                          socketRef.current?.emit("lobbyMessage", lobbyChatInput.trim());
                          setLobbyChatInput("");
                        }
                      }}
                      placeholder="اكتب رسالة..."
                      dir="rtl"
                      maxLength={200}
                      className="flex-1 h-8 text-sm bg-muted/20 border-border/40"
                    />
                    <Button
                      data-testid="button-lobby-chat-send"
                      size="sm" className="h-8 px-3"
                      disabled={!lobbyChatInput.trim()}
                      onClick={() => {
                        if (lobbyChatInput.trim()) {
                          socketRef.current?.emit("lobbyMessage", lobbyChatInput.trim());
                          setLobbyChatInput("");
                        }
                      }}
                    >
                      <Send className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* ── Active games ── */}
          <Card className="border-border/50 shadow-xl">
            <button
              data-testid="button-refresh-rooms"
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors"
              onClick={() => {
                if (!socketRef.current?.connected) return;
                setRefreshingRooms(true);
                socketRef.current.emit("getRooms");
                setTimeout(() => setRefreshingRooms(false), 3000);
              }}
            >
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-blue-400" />
                <span className="font-semibold text-sm">الألعاب الجارية</span>
                {activeRooms.length > 0 && (
                  <span className="text-[10px] bg-blue-500/15 text-blue-400 border border-blue-500/30 px-1.5 py-0.5 rounded-full font-bold">
                    {activeRooms.length}
                  </span>
                )}
              </div>
              <span className={`text-[11px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 ${refreshingRooms ? 'text-blue-400' : ''}`}>
                <RotateCcw className={`w-3 h-3 ${refreshingRooms ? 'animate-spin' : ''}`} />
                {refreshingRooms ? 'جارٍ...' : 'تحديث'}
              </span>
            </button>
            <CardContent className="pt-0 pb-3">
              {activeRooms.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground text-xs">لا توجد ألعاب جارية حالياً</div>
              ) : (
                <div className="space-y-2 px-0">
                  {activeRooms.map((room) => (
                    <div key={room.id} className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-border/40 bg-muted/15 hover:bg-muted/25 transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="font-semibold text-sm truncate">{room.name}</span>
                          <Badge variant="outline" className={`text-[9px] px-1.5 py-0 shrink-0 ${room.status === 'playing' ? 'border-green-500/50 text-green-400' : 'border-yellow-500/50 text-yellow-400'}`}>
                            {room.status === 'playing' ? '▶ جارية' : '⏳ انتظار'}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground/60 mr-auto">{fmtAge(room.createdAt)}</span>
                        </div>
                        {/* Seat grid — team colors */}
                        <div className="flex gap-1 flex-wrap">
                          {Array.from({ length: room.playerCount }, (_, i) => {
                            const isTeam1 = i % 2 === 0;
                            const isBot = room.botSeats?.includes(i);
                            const name: string | undefined = room.seats?.[i];
                            const filled = name !== undefined;
                            return (
                              <div key={i} className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border transition-all ${
                                filled
                                  ? isTeam1
                                    ? 'bg-red-500/15 border-red-500/40 text-red-300'
                                    : 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                                  : 'bg-muted/10 border-border/30 text-muted-foreground/30'
                              }`}>
                                {filled ? (isBot ? '🤖' : '👤') : '○'}
                                {filled && <span className="max-w-[48px] truncate">{name}</span>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        {!isGuestMode && (
                          <button data-testid={`button-join-room-${room.id}`}
                            onClick={() => handleJoinExistingRoom(room.id, room.playerCount, room.status)}
                            className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-bold hover:opacity-90 transition-opacity">
                            انضم
                          </button>
                        )}
                        <button data-testid={`button-spectate-room-${room.id}`}
                          onClick={() => handleJoinAsSpectator(room.id, room.playerCount)}
                          className="px-2.5 py-1.5 rounded-lg border border-border/50 bg-muted/30 text-muted-foreground text-xs font-bold hover:bg-muted/60 transition-all flex items-center gap-1">
                          <Eye className="w-3 h-3" />شاهد
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Admin login section ── */}
          {!isAdmin ? (
            <div className="border border-dashed border-amber-500/20 rounded-xl overflow-hidden">
              {!showAdminLogin ? (
                <button onClick={() => setShowAdminLogin(true)}
                  className="w-full flex items-center justify-center gap-2 py-2.5 text-xs text-amber-500/50 hover:text-amber-400/80 transition-colors">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                  دخول المشرف
                </button>
              ) : (
                <div className="p-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-amber-400 font-semibold">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                    دخول المشرف
                  </div>
                  <div className="flex gap-2">
                    <Input type="password" value={adminPassInput} onChange={e => setAdminPassInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && adminPassInput) {
                          socketRef.current?.emit("adminAuth", adminPassInput);
                        }
                      }}
                      placeholder="كلمة السر..." dir="rtl"
                      className="flex-1 h-8 text-sm bg-black/30 border-amber-500/30 text-amber-100 placeholder:text-amber-500/30" />
                    <Button size="sm" className="h-8 bg-amber-600 hover:bg-amber-700 text-black font-bold px-3"
                      onClick={() => socketRef.current?.emit("adminAuth", adminPassInput)}
                      disabled={!adminPassInput}>
                      دخول
                    </Button>
                    <button onClick={() => { setShowAdminLogin(false); setAdminAuthFailed(false); }}
                      className="h-8 px-2 text-muted-foreground hover:text-foreground transition-colors text-sm">✕</button>
                  </div>
                  {adminAuthFailed && <p className="text-xs text-red-400">كلمة السر غلط</p>}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between px-3 py-2 rounded-xl border border-amber-500/40 bg-amber-500/8">
              <div className="flex items-center gap-2 text-sm text-amber-400 font-bold">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                أنت مشرف ✓
              </div>
              <div className="flex items-center gap-2">
                <a href="/admin" target="_blank" rel="noopener noreferrer"
                  className="text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 px-2.5 py-1 rounded-lg border border-amber-500/30 transition-all font-medium">
                  لوحة التحكم ↗
                </a>
                <button onClick={() => setIsAdmin(false)} className="text-xs text-muted-foreground hover:text-foreground transition-colors">خروج</button>
              </div>
            </div>
          )}

        </div>
      </div>
    );
  }

  // ═══════════════════════ GAME SCREEN ════════════════════════
  return (
    <div className={`game-fullheight felt-bg flex flex-col relative overflow-hidden ${tableTheme !== "green" ? `table-theme-${tableTheme}` : ""}`} dir="rtl"
      style={{ overscrollBehavior: 'none', WebkitOverflowScrolling: 'touch' as any }}>
      <style>{`@-webkit-keyframes floatCard{0%,100%{-webkit-transform:translateY(0)rotate(0);transform:translateY(0)rotate(0);opacity:.05}50%{-webkit-transform:translateY(-20px)rotate(5deg);transform:translateY(-20px)rotate(5deg);opacity:.1}}@keyframes floatCard{0%,100%{transform:translateY(0)rotate(0);opacity:.05}50%{transform:translateY(-20px)rotate(5deg);opacity:.1}}`}</style>

      {/* ── Spectator join notification ── */}
      {spectatorJoinName && (
        <div className="fixed left-1/2 -translate-x-1/2 z-[998] flex items-center gap-2 px-4 py-2 rounded-full border border-border/50 bg-zinc-900/95 shadow-xl backdrop-blur-sm slide-up pointer-events-none"
          style={{ top: 'calc(56px + env(safe-area-inset-top, 0px))' }}>
          <Eye className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <span className="text-foreground text-xs font-semibold">{spectatorJoinName}</span>
          <span className="text-white/50 text-xs">يشاهد الآن</span>
        </div>
      )}

      {/* ── Game invite notification ── */}
      {incomingInvite && (
        <div className="fixed inset-x-4 z-[999] flex justify-center" style={{ top: 'calc(64px + env(safe-area-inset-top, 0px))' }} dir="rtl">
          <div className="bg-zinc-900/97 border border-amber-500/60 rounded-2xl px-5 py-4 shadow-2xl backdrop-blur-sm flex flex-col gap-3 w-full max-w-sm slide-up">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                <Users className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <p className="text-sm font-bold text-foreground">دعوة للعب!</p>
                <p className="text-xs text-muted-foreground">
                  <span className="text-amber-400 font-semibold">{incomingInvite.inviterName}</span> دعاك للعب معه
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground bg-muted/20 rounded-lg px-3 py-1.5">
              غرفة: <span className="text-foreground font-medium">{incomingInvite.roomName}</span> · {incomingInvite.playerCount} لاعبين
            </p>
            <div className="flex gap-2">
              <Button
                data-testid="button-invite-accept"
                size="sm"
                className="flex-1 h-8 bg-green-600 hover:bg-green-700 text-white font-bold"
                onClick={() => {
                  const pc = (incomingInvite.playerCount === 6 ? 6 : 4) as 4 | 6;
                  let name = playerName.trim() || "لاعب";
                  try { name = localStorage.getItem("speet-name") || name; } catch { /* ignore */ }
                  setPlayerCount(pc);
                  setStartMode("wait");
                  startModeRef.current = "wait";
                  initGameState(pc, incomingInvite.roomId);
                  setPhase("game");
                  setIsHost(false);
                  isHostRef.current = false;
                  pendingJoinRef.current = { roomId: incomingInvite.roomId, name };
                  socketRef.current?.emit("joinRoom", incomingInvite.roomId, name);
                  setIncomingInvite(null);
                }}
              >
                ✓ قبول
              </Button>
              <Button
                data-testid="button-invite-decline"
                size="sm"
                variant="outline"
                className="flex-1 h-8 border-border/40 text-muted-foreground hover:text-foreground"
                onClick={() => setIncomingInvite(null)}
              >
                رفض
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Last trick overlay ── */}
      {showLastTrickOverlay && lastTrickCards.length > 0 && (
        <div className="fixed inset-0 z-[990] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setShowLastTrickOverlay(false)}>
          <div className="glass-panel rounded-2xl p-5 max-w-xs w-[88vw] flex flex-col items-center gap-3 border border-white/15 shadow-2xl"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-white/70 text-sm font-semibold">
              <History className="w-4 h-4" />الأكلة الأخيرة
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {lastTrickCards.map(({ pi, card }) => {
                const isRed = card.includes("♥") || card.includes("♦") || card === "🃏R";
                const isJoker = card === JOKER_B || card === JOKER_R;
                return (
                  <div key={pi} className="flex flex-col items-center gap-1">
                    <div className="w-11 rounded-lg border border-zinc-300/40 flex items-center justify-center py-1.5 text-lg font-bold shadow"
                      style={{ backgroundColor: '#ffffff', color: isRed ? '#dc2626' : '#111827', minHeight: 56 }}>
                      {isJoker ? (card === JOKER_R ? "🃏" : "🃟") : card}
                    </div>
                    <span className="text-[9px] text-white/40 leading-none">{players[pi]?.name}</span>
                  </div>
                );
              })}
            </div>
            {lastTrickWinner !== null && (
              <div className="text-yellow-300 text-xs font-bold">
                فاز: {players[lastTrickWinner]?.name}
              </div>
            )}
            <button onClick={() => setShowLastTrickOverlay(false)}
              className="mt-1 text-white/30 hover:text-white/60 text-xs transition-all">إغلاق</button>
          </div>
        </div>
      )}

      {/* ── Admin announcement banner ── */}
      {adminAnnouncement && (
        <div className="fixed left-1/2 -translate-x-1/2 z-[999] flex items-center gap-3 px-5 py-3 rounded-2xl border border-pink-500/60 bg-zinc-900/95 shadow-2xl shadow-pink-500/20 backdrop-blur-sm max-w-sm w-[90vw] animate-pulse"
          style={{ top: 'max(12px, env(safe-area-inset-top, 12px))' }}>
          <span className="text-xl shrink-0">📢</span>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] text-pink-400 font-bold uppercase tracking-wider mb-0.5">إعلان من المشرف</div>
            <div className="text-sm text-white font-medium">{adminAnnouncement}</div>
          </div>
          <button onClick={() => setAdminAnnouncement(null)} className="text-zinc-500 hover:text-white shrink-0">✕</button>
        </div>
      )}


      {/* ── Admin floating button (game screen) ── */}
      {isAdmin && !showAdminOverlay && (
        <button onClick={() => { setShowAdminOverlay(true); socketRef.current?.emit("adminGetState"); }}
          className="fixed bottom-20 left-3 z-[90] w-10 h-10 rounded-full bg-amber-600/90 border border-amber-400/60 shadow-lg shadow-amber-500/30 flex items-center justify-center hover:bg-amber-500 transition-all hover:scale-110"
          title="لوحة تحكم المشرف">
          <svg className="w-5 h-5 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
        </button>
      )}

      {/* ── Admin overlay panel (in-game) ── */}
      {isAdmin && showAdminOverlay && (
        <div className="fixed inset-0 z-[95] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowAdminOverlay(false)} />
          <div className="relative w-full sm:max-w-md max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-amber-500/40 bg-zinc-950 shadow-2xl overflow-hidden" dir="rtl">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900 shrink-0">
              <div className="flex items-center gap-2 text-amber-400 font-bold text-sm">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                لوحة تحكم المشرف
              </div>
              <div className="flex items-center gap-2">
                <div className="text-xs text-zinc-500">{adminState?.totalConnected ?? 0} متصل · {adminState?.totalRooms ?? 0} غرفة</div>
                <button onClick={() => socketRef.current?.emit("adminGetState")}
                  className="text-zinc-500 hover:text-amber-400 transition-colors p-1">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                </button>
                <button onClick={() => setShowAdminOverlay(false)} className="text-zinc-500 hover:text-white transition-colors">✕</button>
              </div>
            </div>

            {/* Announce */}
            <div className="flex gap-2 px-3 py-2 border-b border-zinc-800 shrink-0">
              <input value={adminAnnounceInput} onChange={e => setAdminAnnounceInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && adminAnnounceInput.trim()) {
                    socketRef.current?.emit("adminAnnounce", adminAnnounceInput.trim());
                    setAdminAnnounceInput("");
                  }
                }}
                placeholder="إعلان لجميع اللاعبين..." dir="rtl"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-base md:text-sm text-white placeholder:text-zinc-600 outline-none focus:border-amber-500/50" />
              <button onClick={() => {
                if (adminAnnounceInput.trim()) {
                  socketRef.current?.emit("adminAnnounce", adminAnnounceInput.trim());
                  setAdminAnnounceInput("");
                }
              }} disabled={!adminAnnounceInput.trim()}
                className="px-3 py-1.5 rounded-lg bg-pink-600 hover:bg-pink-700 disabled:opacity-40 text-white text-sm font-bold transition-colors shrink-0">
                إرسال
              </button>
            </div>

            {/* Rooms list */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {(!adminState || adminState.rooms.length === 0) ? (
                <div className="text-center py-8 text-zinc-600 text-sm">لا توجد غرف نشطة</div>
              ) : adminState.rooms.map((room: any) => (
                <div key={room.id} className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-sm truncate">{room.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold border ${room.status === "playing" ? "bg-green-500/15 text-green-400 border-green-500/30" : "bg-zinc-700/50 text-zinc-400 border-zinc-600/30"}`}>
                          {room.status === "playing" ? "جارية" : "انتظار"}
                        </span>
                      </div>
                      {room.hasGame && room.gameState && (
                        <div className="text-[10px] text-zinc-500 mt-0.5">
                          العربي: <span className="text-red-400 font-bold">{room.gameState.team1Score ?? 0}</span>
                          {" · "}السد: <span className="text-sky-400 font-bold">{room.gameState.team2Score ?? 0}</span>
                          {" · "}جولة {room.gameState.roundNumber ?? 0}
                        </div>
                      )}
                    </div>
                    <button onClick={() => {
                      if (confirm(`إغلاق غرفة "${room.name}"؟`)) socketRef.current?.emit("adminCloseRoom", room.id);
                    }} className="px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs hover:bg-red-500/20 transition-colors shrink-0 font-bold">
                      إغلاق
                    </button>
                  </div>
                  {/* Players */}
                  {room.players.length > 0 && (
                    <div className="border-t border-zinc-800/60 px-3 pb-2 pt-1 space-y-1">
                      {room.players.map((p: any) => {
                        const isBot = room.botSeats?.includes(p.seatIndex);
                        const isEven = p.seatIndex % 2 === 0;
                        return (
                          <div key={p.socketId} className="flex items-center gap-2">
                            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border shrink-0 ${isBot ? "bg-zinc-700 border-zinc-600 text-zinc-400" : isEven ? "bg-red-900 border-red-500/50 text-red-200" : "bg-sky-900 border-sky-500/50 text-sky-200"}`}>
                              {p.seatIndex >= 0 ? p.seatIndex + 1 : "?"}
                            </div>
                            <span className="text-xs text-white flex-1 truncate">{p.name}{isBot && <span className="text-zinc-500 mr-1">🤖</span>}</span>
                            {!isBot && (
                              <button onClick={() => {
                                if (confirm(`طرد "${p.name}"؟`)) socketRef.current?.emit("adminKick", p.socketId);
                              }} className="px-1.5 py-0.5 rounded bg-orange-500/10 border border-orange-500/30 text-orange-400 text-[10px] hover:bg-orange-500/20 transition-colors font-bold shrink-0">
                                طرد
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Log strip */}
            <div className="border-t border-zinc-800 px-3 py-2 bg-zinc-900/80 shrink-0">
              <div className="text-[10px] text-zinc-600 font-mono space-y-0 max-h-16 overflow-y-auto" dir="ltr">
                {adminLogEntries.slice(-6).map((entry, i) => (
                  <div key={i} className="truncate">
                    <span className="text-zinc-700">{new Date(entry.ts).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                    {" "}<span className="text-amber-500/60">[{entry.event}]</span>
                    {" "}<span className="text-zinc-400">{entry.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Mid-game seat picker overlay ── */}
      {needsSeatPick && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm">
          <Card className="w-80 border-border/50 shadow-2xl">
            <CardHeader className="text-center pb-2">
              <div className="text-3xl mb-2">🎮</div>
              <CardTitle className="text-lg">اختر مقعدك</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">اللعبة جارية — انضم بدل لاعب آلي</p>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              {joinBotSeats.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground text-sm">لا توجد مقاعد آلية متاحة حالياً</div>
              ) : (
                joinBotSeats.map(seat => {
                  const isT1 = seat % 2 === 0;
                  return (
                    <button key={seat} data-testid={`button-takeseat-${seat}`}
                      onClick={() => { try { localStorage.setItem("speet-last-seat", String(seat)); } catch { /* ignore */ } socketRef.current?.emit("takeSeatRequest", { roomId: roomIdRef.current, seat, name: playerName }); }}
                      className={`w-full py-3 px-4 rounded-xl border-2 font-bold text-sm transition-all flex items-center gap-3 hover:scale-[1.02]
                        ${isT1 ? "border-red-500/60 bg-red-900/20 text-red-200 hover:bg-red-900/40" : "border-zinc-500/60 bg-zinc-800/20 text-zinc-200 hover:bg-zinc-800/40"}`}>
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center border-2 font-extrabold
                        ${isT1 ? "bg-red-900 border-red-400 text-red-100" : "bg-zinc-800 border-zinc-400 text-zinc-100"}`}>
                        {seat + 1}
                      </div>
                      <div className="flex flex-col items-start gap-0.5">
                        <span>مقعد {seat + 1}</span>
                        <span className={`text-xs font-normal ${isT1 ? "text-red-400" : "text-zinc-400"}`}>
                          {isT1 ? "فريق العربي" : "فريق السد"} · 🤖 {isT1 ? "عرباوي" : "سداوي"}{Math.floor(seat / 2) + 1}
                        </span>
                      </div>
                      <ChevronRight className="w-4 h-4 mr-auto opacity-50" />
                    </button>
                  );
                })
              )}
              <button onClick={() => { setNeedsSeatPick(false); setPhase("rooms"); }}
                className="w-full py-2 text-xs text-muted-foreground hover:text-foreground transition-colors mt-1">
                رجوع للصالة
              </button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-border/40 bg-card/60 backdrop-blur-sm px-3 flex items-center justify-between sticky top-0 z-40 flex-shrink-0"
        style={{ paddingTop: 'max(8px, env(safe-area-inset-top, 8px))', paddingBottom: '8px' }}>
        <div className="flex items-center gap-2">
          <div className="text-lg select-none hidden xs:block">♠ ♥</div>
          <div>
            <h1 className="font-bold text-sm leading-tight gold-text">حكم سبيت</h1>
            <p className="text-[10px] text-muted-foreground flex items-center gap-1">
              {isSpectator
                ? <><Eye className="w-3 h-3 text-muted-foreground" /><span className="text-muted-foreground">مشاهد</span></>
                : players[myIndex]?.name || playerName}
              · ج{roundNumber + 1}
            </p>
          </div>
        </div>
        {/* ── Live score strip (comprehensive) ── */}
        {inGameSession && !gameOver && (() => {
          const crisisThreshold = Math.floor(maxScore * 0.20);
          const t1Crisis = team1Score >= maxScore - crisisThreshold && team1Score < maxScore;
          const t2Crisis = team2Score >= maxScore - crisisThreshold && team2Score < maxScore;
          const t1RoundWon = tricksWon.filter((_, i) => i % 2 === 0).reduce((a, v) => a + v, 0);
          const t2RoundWon = tricksWon.filter((_, i) => i % 2 !== 0).reduce((a, v) => a + v, 0);
          const t1Bid = submittedPurchases.filter((_, i) => i % 2 === 0).reduce<number>((a, v) => a + (v ?? 0), 0);
          const t2Bid = submittedPurchases.filter((_, i) => i % 2 !== 0).reduce<number>((a, v) => a + (v ?? 0), 0);
          const bidsDone = submittedPurchases.some(b => b !== null && b !== undefined);
          const totalTricksLocal = playerCount === 4 ? 13 : 9;
          const t1Lawrence = bidsDone && t1Bid >= totalTricksLocal;
          const t2Lawrence = bidsDone && t2Bid >= totalTricksLocal;
          const t1Achieved = playingPhase && bidsDone && t1RoundWon >= t1Bid && !t1Lawrence;
          const t2Achieved = playingPhase && bidsDone && t2RoundWon >= t2Bid && !t2Lawrence;
          return (
            <div className={`flex items-stretch gap-0 rounded-xl overflow-hidden border flex-shrink-0 transition-all duration-500 ${t1Crisis || t2Crisis ? "border-red-500/60 animate-pulse" : "border-white/12"}`}>
              {/* العربي */}
              <div className={`flex flex-col items-center justify-center px-2 sm:px-2.5 py-1 min-w-[52px] sm:min-w-[62px]
                ${t1Lawrence ? "bg-yellow-900/60" : t1Crisis ? "bg-red-900/60" : "bg-rose-950/50"}`}>
                <img src={arabiLogo} alt="العربي" className="w-4 h-4 rounded-full object-cover mb-0.5 opacity-90" />
                <span className="text-[9px] font-bold text-red-400/80 leading-none mb-0.5">العربي</span>
                {/* Total score */}
                <span className={`text-base font-black leading-none tabular-nums${scoreFlashT1 ? " score-flash" : ""} ${t1Lawrence ? "text-yellow-300" : t1Crisis ? "text-red-200" : "text-red-400"}`}>{team1Score}</span>
                {/* Round progress */}
                {bidsDone && playingPhase && (
                  <span className={`text-[9px] leading-none mt-0.5 font-bold tabular-nums
                    ${t1Lawrence ? "text-yellow-300" : t1Achieved ? "text-green-300" : "text-rose-300/70"}`}>
                    {t1RoundWon}<span className="text-white/30">/{t1Bid}</span>
                    {t1Lawrence && <span className="ml-0.5">⚡</span>}
                    {t1Achieved && <span className="ml-0.5">✓</span>}
                  </span>
                )}
                {bidsDone && !playingPhase && t1Bid > 0 && (
                  <span className="text-[9px] leading-none mt-0.5 font-bold text-rose-300/60">طلب {t1Bid}</span>
                )}
                <span className="text-[8px] text-white/20 leading-none mt-0.5">من {maxScore}</span>
              </div>
              {/* center divider */}
              <div className="w-px bg-white/10 flex items-center justify-center">
                <span className="text-[8px] text-white/20 font-normal select-none">vs</span>
              </div>
              {/* السد */}
              <div className={`flex flex-col items-center justify-center px-2 sm:px-2.5 py-1 min-w-[52px] sm:min-w-[62px]
                ${t2Lawrence ? "bg-yellow-900/60" : t2Crisis ? "bg-sky-900/60" : "bg-sky-950/50"}`}>
                <img src={saddLogo} alt="السد" className="w-4 h-4 rounded-full object-cover mb-0.5 opacity-90" />
                <span className="text-[9px] font-bold text-sky-400/80 leading-none mb-0.5">السد</span>
                {/* Total score */}
                <span className={`text-base font-black leading-none tabular-nums${scoreFlashT2 ? " score-flash" : ""} ${t2Lawrence ? "text-yellow-300" : t2Crisis ? "text-sky-200" : "text-sky-400"}`}>{team2Score}</span>
                {/* Round progress */}
                {bidsDone && playingPhase && (
                  <span className={`text-[9px] leading-none mt-0.5 font-bold tabular-nums
                    ${t2Lawrence ? "text-yellow-300" : t2Achieved ? "text-green-300" : "text-sky-300/70"}`}>
                    {t2RoundWon}<span className="text-white/30">/{t2Bid}</span>
                    {t2Lawrence && <span className="ml-0.5">⚡</span>}
                    {t2Achieved && <span className="ml-0.5">✓</span>}
                  </span>
                )}
                {bidsDone && !playingPhase && t2Bid > 0 && (
                  <span className="text-[9px] leading-none mt-0.5 font-bold text-sky-300/60">طلب {t2Bid}</span>
                )}
                <span className="text-[8px] text-white/20 leading-none mt-0.5">من {maxScore}</span>
              </div>
            </div>
          );
        })()}
        {gameOver && (
          <div className="flex items-center gap-1 text-xs font-bold bg-yellow-500/20 border border-yellow-400/40 rounded-lg px-2.5 py-1.5 flex-shrink-0 text-yellow-300">
            🏆 {winner} فاز!
          </div>
        )}

        <div className="flex items-center gap-1.5">
          {/* Spectator count indicator */}
          {spectators.length > 0 && (
            <div className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted/30 border border-border/40 text-muted-foreground text-[10px] font-bold flex-shrink-0"
              title={spectators.map(s => s.name).join("، ")}>
              <Eye className="w-3 h-3" />
              <span>{spectators.length}</span>
            </div>
          )}
          {/* Connection dot — minimal, non-interactive */}
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? "bg-green-400" : "bg-red-400"}`} title={connected ? "متصل" : "غير متصل"} />
          {/* Sound toggle — always visible */}
          <Button data-testid="button-toggle-sound" size="icon"
            variant={soundEnabled ? "outline" : "ghost"}
            onClick={() => setSoundEnabled(v => !v)}
            className={`h-8 w-8 flex ${!soundEnabled ? "opacity-50" : ""}`}
            title={soundEnabled ? "إيقاف الصوت" : "تشغيل الصوت"}>
            {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </Button>
          {/* Mic toggle — visible on all screen sizes */}
          <Button data-testid="button-toggle-mic" size="icon" variant={micOn ? "default" : "outline"} onClick={toggleMic} className="h-8 w-8 flex" title={micOn ? "إيقاف المايك" : "تشغيل المايك"}>
            {micOn ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
          </Button>
          {/* Chat */}
          <Button data-testid="button-toggle-chat" size="icon" variant="outline" onClick={() => setChatOpen((v) => !v)} className="h-8 w-8 relative">
            <MessageCircle className="w-4 h-4" />
            {chatMessages.length > 0 && <span className="absolute -top-1 -left-1 w-3.5 h-3.5 bg-primary rounded-full text-[9px] text-primary-foreground flex items-center justify-center font-bold">{chatMessages.length > 9 ? "9+" : chatMessages.length}</span>}
          </Button>
          {/* Settings — all other options live here */}
          <Button data-testid="button-settings" size="icon" variant={showSettings ? "default" : "outline"} onClick={() => setShowSettings(v => !v)} className="h-8 w-8">
            <Settings className="w-4 h-4" />
          </Button>
          {/* Exit */}
          <Button data-testid="button-exit-game" size="icon" variant="outline" onClick={handleExitGame} className="h-8 w-8 border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300">
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden min-h-0">
        <div className={!gameOver && (playingPhase || myHand.length > 0 || inGameSession) ? "flex-1 overflow-hidden flex flex-col min-h-0" : "flex-1 overflow-y-auto p-3 flex flex-col items-center gap-3"}>

          {/* Game Over */}
          {gameOver && (
            <div className="slide-up space-y-3 w-full max-w-sm">
              {/* Winner card */}
              <div className="bg-primary/10 border border-primary/30 rounded-lg p-4 text-center space-y-3">
                <div className="flex items-center justify-center gap-3 mb-2">
                  <Trophy className="w-8 h-8 text-primary" />
                  <img
                    src={winner === "العربي" ? arabiLogo : saddLogo}
                    alt={winner}
                    className="w-14 h-14 rounded-full object-cover border-2 border-yellow-400/60 shadow-lg shadow-yellow-400/20"
                  />
                  <Trophy className="w-8 h-8 text-primary" />
                </div>
                <h2 className="text-xl font-bold gold-text">اللعبة انتهت!</h2>
                <p className="text-foreground/80 font-bold text-lg">🏆 {winner} فاز!</p>
                <div className="flex items-center justify-center gap-2 text-sm font-bold">
                  <span className="text-red-400">العربي: {team1Score}</span>
                  <span className="text-white/30">·</span>
                  <span className="text-sky-400">السد: {team2Score}</span>
                  <span className="text-white/30">·</span>
                  <span className="text-white/50 text-xs">{roundNumber} جولة</span>
                </div>
                {/* Session stats summary */}
                {(sessionStats.wins + sessionStats.losses) > 0 && (
                  <div className="flex items-center justify-center gap-3 text-xs py-1.5 px-3 rounded-lg bg-black/30 border border-white/10">
                    <span className="text-green-400 font-bold">✓ {sessionStats.wins} فوز</span>
                    <span className="text-white/20">|</span>
                    <span className="text-rose-400 font-bold">✗ {sessionStats.losses} خسارة</span>
                    <span className="text-white/20">|</span>
                    <span className="text-amber-400">★ {sessionStats.tricks} طلعة</span>
                  </div>
                )}
                {/* Action buttons */}
                <div className="flex gap-2 justify-center mt-2">
                  <Button onClick={() => handleReset()} size="sm">
                    <RotateCcw className="w-3.5 h-3.5 ml-1.5" />العب مجدداً
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => {
                    const lines = [
                      `🃏 حكم سبيت — ${roundNumber} جولة`,
                      `🏆 الفائز: ${winner}`,
                      `🔴 العربي: ${team1Score} نقطة`,
                      `🔵 السد: ${team2Score} نقطة`,
                      ...roundLog.slice(-5).map((l, idx2) => `  ${idx2 + 1}. ${l}`),
                    ].join("\n");
                    if (navigator.share) {
                      navigator.share({ title: "حكم سبيت", text: lines }).catch(() => {});
                    } else if (navigator.clipboard?.writeText) {
                      navigator.clipboard.writeText(lines).then(() => toast({ title: "تم النسخ!", description: "نتيجة اللعبة جاهزة للمشاركة", duration: 2000 })).catch(() => {
                        const el = document.createElement("textarea"); el.value = lines;
                        document.body.appendChild(el); el.select(); document.execCommand("copy"); document.body.removeChild(el);
                        toast({ title: "تم النسخ!", duration: 2000 });
                      });
                    } else {
                      const el = document.createElement("textarea"); el.value = lines;
                      document.body.appendChild(el); el.select(); document.execCommand("copy"); document.body.removeChild(el);
                      toast({ title: "تم النسخ!", duration: 2000 });
                    }
                  }}>
                    <Share2 className="w-3.5 h-3.5 ml-1.5" />مشاركة
                  </Button>
                </div>
              </div>

              {/* Per-player stats panel */}
              {gameStats.tricksPerPlayer.length > 0 && players.length > 0 && (
                <div className="rounded-xl border border-white/10 overflow-hidden"
                  style={{ background: 'rgba(10,10,24,0.85)' }}>
                  <div className="text-[10px] font-bold text-white/40 uppercase tracking-wider px-3 pt-3 pb-1">إحصائيات اللاعبين</div>
                  <div className="divide-y divide-white/5">
                    {Array.from({ length: players.length }, (_, i) => i)
                      .sort((a, b) => (gameStats.tricksPerPlayer[b] ?? 0) - (gameStats.tricksPerPlayer[a] ?? 0))
                      .map((pi) => {
                        const player = players[pi];
                        if (!player) return null;
                        const isT1 = pi % 2 === 0;
                        const tricks = gameStats.tricksPerPlayer[pi] ?? 0;
                        const trumps = gameStats.trumpPerPlayer[pi] ?? 0;
                        const totalTricks = gameStats.tricksPerPlayer.reduce((a, v) => a + v, 0);
                        const trickPct = totalTricks > 0 ? Math.round((tricks / totalTricks) * 100) : 0;
                        const isWinnerTeam = (isT1 && winner === "العربي") || (!isT1 && winner === "السد");
                        return (
                          <div key={pi} className="flex items-center gap-3 px-3 py-2.5">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center font-black text-sm flex-shrink-0 border-2
                              ${isT1 ? "bg-red-900 border-red-400 text-red-100" : "bg-zinc-800 border-zinc-500 text-zinc-100"}`}>
                              {player.name.slice(0, 2)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 mb-0.5">
                                <span className="text-xs font-bold text-white/90 truncate">{player.name}</span>
                                {isWinnerTeam && <span className="text-[9px] text-yellow-400">🏆</span>}
                                <img src={isT1 ? arabiLogo : saddLogo} alt={isT1 ? "العربي" : "السد"} className="w-3.5 h-3.5 rounded-full object-cover opacity-80" />
                                <span className={`text-[9px] ${isT1 ? "text-red-400" : "text-zinc-400"}`}>{isT1 ? "العربي" : "السد"}</span>
                              </div>
                              <div className="w-full h-1.5 rounded-full bg-white/5 overflow-hidden">
                                <div className={`h-full rounded-full transition-all ${isT1 ? "bg-red-500" : "bg-zinc-500"}`}
                                  style={{ width: trickPct + "%" }} />
                              </div>
                            </div>
                            <div className="text-right flex-shrink-0 space-y-0.5">
                              <div className="text-xs font-black text-white/90">{tricks} <span className="font-normal text-white/40 text-[10px]">طلعة</span></div>
                              <div className="text-[10px] text-white/40">♠ {trumps} بيت</div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Round history panel */}
              {roundLog.length > 0 && (
                <div className="rounded-xl border border-white/10 overflow-hidden" style={{ background: 'rgba(10,10,24,0.85)' }}>
                  <button
                    onClick={() => setShowRoundHistory(v => !v)}
                    className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-white/5 transition-all">
                    <span className="text-[10px] font-bold text-white/40 uppercase tracking-wider">تاريخ الجولات</span>
                    <span className={`text-white/30 text-xs transition-transform ${showRoundHistory ? "rotate-180" : ""}`}>▼</span>
                  </button>
                  {showRoundHistory && (
                    <div className="divide-y divide-white/5 max-h-48 overflow-y-auto">
                      {roundLog.map((log, i) => (
                        <div key={i} className="flex gap-2 px-3 py-1.5">
                          <span className="text-[9px] text-white/25 font-bold flex-shrink-0 w-5 text-center">{i + 1}</span>
                          <span className="text-[10px] text-white/60 leading-relaxed">{log}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Auto-redeal countdown banner (only shown when NOT in table view) ── */}
          {!gameOver && !inGameSession && nextRoundCountdown !== null && (
            <div className="slide-up rounded-xl p-4 text-center border border-white/10 bg-black/40 w-full max-w-sm">
              <div className="text-white/60 text-xs mb-2">نتيجة الجولة</div>
              {lastRoundSummary && (
                <div className="text-sm font-bold text-white mb-3 leading-relaxed">{lastRoundSummary}</div>
              )}
              <div className="flex items-center justify-center gap-3">
                <div className="w-12 h-12 rounded-full bg-yellow-400/20 border-2 border-yellow-400 flex items-center justify-center text-yellow-300 font-black text-xl">
                  {nextRoundCountdown}
                </div>
                <span className="text-white/70 text-sm">جولة جديدة تبدأ خلال…</span>
              </div>
              <div className="mt-3 flex gap-2 justify-center text-xs text-white/40">
                <span>🔴 العربي: {team1Score}</span>
                <span>·</span>
                <span>🔵 السد: {team2Score}</span>
                <span>·</span>
                <span>الهدف: {maxScoreRef.current}</span>
              </div>
            </div>
          )}


          {/* ── Invite from lobby ── */}
          {!gameOver && !playingPhase && myHand.length === 0 && !isSpectator && (() => {
            const otherLobbyPlayers = lobbyPlayers.filter(p => p.socketId !== socketRef.current?.id);
            if (otherLobbyPlayers.length === 0) return null;
            return (
              <Card className="border-border/40 w-full max-w-sm">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Users className="w-4 h-4 text-primary" />
                    <span className="text-sm font-semibold text-foreground">دعوة من الصالة</span>
                    <span className="text-xs text-muted-foreground ml-auto">{otherLobbyPlayers.length} في الصالة</span>
                  </div>
                  <div className="space-y-2">
                    {otherLobbyPlayers.map((p) => (
                      <div key={p.socketId} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-muted/20 border border-border/20">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
                          <span className="text-sm text-foreground truncate">{p.name}</span>
                        </div>
                        <Button
                          data-testid={`button-invite-${p.socketId}`}
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-3 border-primary/40 text-primary hover:bg-primary/10 flex-shrink-0"
                          onClick={() => {
                            socketRef.current?.emit("invitePlayer", {
                              targetSocketId: p.socketId,
                              roomId: roomIdRef.current,
                              roomName: activeRooms.find(r => r.id === roomIdRef.current)?.name ?? roomIdRef.current,
                              playerCount: playerCount,
                            });
                          }}
                        >
                          <Share2 className="w-3 h-3 mr-1" /> دعوة
                        </Button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* Bots active banner */}
          {!gameOver && !playingPhase && myHand.length === 0 && botSeats.size > 0 && (
            <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/30 rounded-lg px-3 py-2 text-xs text-blue-300 w-full max-w-sm">
              <span>🤖</span>
              <span>تم إضافة {botSeats.size} لاعب آلي للمقاعد الفارغة</span>
            </div>
          )}

          {/* Score Board */}
          {(!playingPhase || gameOver) && (myHand.length === 0 || gameOver) && (
          <Card className="border-border/40 w-full max-w-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Trophy className="w-4 h-4 text-primary" />النقاط
                <Badge variant="secondary" className="mr-auto text-xs">الهدف: {maxScore}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ScoreBar score={Math.max(0, team1Score)} maxScore={maxScore} label="العربي" color="bg-red-500" />
              <ScoreBar score={Math.max(0, team2Score)} maxScore={maxScore} label="السد" color="bg-zinc-600" />
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div className="bg-red-500/10 border border-red-500/20 rounded-md p-3 text-center">
                  <img src={arabiLogo} alt="العربي" className="w-8 h-8 rounded-full object-cover mx-auto mb-1.5" />
                  <div className="text-2xl font-bold text-red-400" data-testid="score-team1">{team1Score}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">العربي</div>
                </div>
                <div className="bg-zinc-700/20 border border-zinc-500/30 rounded-md p-3 text-center">
                  <img src={saddLogo} alt="السد" className="w-8 h-8 rounded-full object-cover mx-auto mb-1.5" />
                  <div className="text-2xl font-bold text-zinc-300" data-testid="score-team2">{team2Score}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">السد</div>
                </div>
              </div>
            </CardContent>
          </Card>
          )}

          {/* ════ Spectator watch banner ════ */}
          {isSpectator && !gameOver && !playingPhase && (
            <Card className="border-border/50 bg-muted/5 w-full max-w-sm">
              <CardContent className="pt-5 pb-5 text-center space-y-3">
                <div className="flex justify-center">
                  <div className="w-14 h-14 rounded-full bg-muted/30 border border-border/40 flex items-center justify-center">
                    <Eye className="w-7 h-7 text-muted-foreground" />
                  </div>
                </div>
                <div>
                  <p className="font-semibold text-foreground text-sm">أنت تشاهد هذه اللعبة</p>
                  <p className="text-xs text-muted-foreground mt-1">يمكنك تفعيل الميكروفون للتحدث مع اللاعبين</p>
                </div>
                {spectators.length > 0 && (
                  <div className="flex flex-wrap justify-center gap-1.5 pt-1">
                    {spectators.map((s) => (
                      <span key={s.socketId} className="text-[10px] px-2 py-0.5 rounded-full bg-muted/30 border border-border/30 text-muted-foreground">
                        {s.name}
                      </span>
                    ))}
                  </div>
                )}
                <Button data-testid="button-toggle-mic-spectator" variant="outline"
                  onClick={toggleMic}
                  className={`mt-1 border-border/50 ${micOn ? "bg-primary/20 text-primary" : "text-muted-foreground hover:bg-muted/30"}`}>
                  {micOn ? <Mic className="w-4 h-4 ml-2" /> : <MicOff className="w-4 h-4 ml-2" />}
                  {micOn ? "الميكروفون شغّال" : "تفعيل الميكروفون"}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* ════ ROUND CARD (pre-deal only — when no cards yet) ════ */}
          {!gameOver && !playingPhase && myHand.length === 0 && !isSpectator && (
            <Card className="border-border/40 w-full max-w-sm">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span>🃏</span>
                  {myHand.length > 0 ? "كروتك والشراء – جولة " + (roundNumber + 1) : "توزيع الكروت – جولة " + (roundNumber + 1)}
                  {myHand.length > 0 && (
                    <span className="mr-auto text-xs text-muted-foreground font-normal">{submittedCount}/{playerCount} أكملوا</span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 px-4 pb-4">

                {myHand.length === 0 ? (
                  /* ── No cards yet ── */
                  <div className="space-y-3">
                    {botCountdown !== null && botSeats.size === 0 ? (
                      /* ── Waiting for players: countdown + seat picker ── */
                      <div className="flex flex-col items-center gap-3">
                        {/* Countdown row: ring + label */}
                        <div className="flex items-center gap-3 bg-yellow-400/5 border border-yellow-400/20 rounded-xl px-4 py-2.5 w-full">
                          <div className="relative w-14 h-14 flex items-center justify-center flex-shrink-0">
                            <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 56 56">
                              <circle cx="28" cy="28" r="22" fill="none" stroke="rgba(234,179,8,0.12)" strokeWidth="5" />
                              <circle cx="28" cy="28" r="22" fill="none" stroke="rgba(234,179,8,0.80)" strokeWidth="5"
                                strokeDasharray={`${2 * Math.PI * 22}`}
                                strokeDashoffset={`${2 * Math.PI * 22 * (1 - (botCountdown ?? 0) / 25)}`}
                                strokeLinecap="round" className="transition-all duration-1000" />
                            </svg>
                            <span className="text-xl font-black tabular-nums leading-none" style={{ color: '#800020' }}>{botCountdown}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 text-yellow-400/90 font-bold text-sm">
                              <Clock className="w-3.5 h-3.5 animate-pulse flex-shrink-0" />
                              انتظار اللاعبين
                            </div>
                            <p className="text-[11px] text-yellow-400/50 mt-0.5">سيبدأ اللاعبون الآليون تلقائياً</p>
                          </div>
                        </div>

                        {/* Seat picker */}
                        <div className="w-full space-y-2">
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="text-[11px] font-bold text-yellow-400/70">اختر مقعدك</span>
                            <div className="flex items-center gap-2 text-[10px]">
                              <span className="flex items-center gap-1 text-rose-400/70">● العربي</span>
                              <span className="flex items-center gap-1 text-sky-400/70">● السد</span>
                            </div>
                          </div>
                          <div className={`grid gap-1.5 ${playerCount === 4 ? "grid-cols-2" : "grid-cols-3"}`}>
                            {Array.from({ length: playerCount }, (_, i) => {
                              const isT1 = i % 2 === 0;
                              const claimed = claimedSeats[i];
                              const isMe = i === myIndex;
                              const isTaken = claimed && claimed !== (playerName || "لاعب");
                              return (
                                <button
                                  key={i}
                                  data-testid={`button-seat-countdown-${i}`}
                                  disabled={!!isTaken}
                                  onClick={() => {
                                    if (isTaken) return;
                                    setMyIndex(i);
                                    myIndexRef.current = i;
                                    try { localStorage.setItem("speet-last-seat", String(i)); } catch { /* ignore */ }
                                    const name = playerName || "لاعب";
                                    socketRef.current?.emit("claimSeat", { roomId: roomIdRef.current, index: i, name });
                                  }}
                                  className="relative flex items-center gap-2 px-2.5 py-2 rounded-xl transition-all duration-200 text-right"
                                  style={{
                                    border: isMe
                                      ? isT1 ? '2px solid rgba(251,113,133,0.8)' : '2px solid rgba(56,189,248,0.8)'
                                      : isTaken ? '1.5px solid rgba(255,255,255,0.08)' : isT1 ? '1.5px solid rgba(251,113,133,0.22)' : '1.5px solid rgba(56,189,248,0.22)',
                                    background: isMe
                                      ? isT1 ? 'rgba(244,63,94,0.16)' : 'rgba(14,165,233,0.16)'
                                      : isTaken ? 'rgba(255,255,255,0.03)' : isT1 ? 'rgba(244,63,94,0.05)' : 'rgba(14,165,233,0.05)',
                                    opacity: isTaken ? 0.55 : 1,
                                    cursor: isTaken ? 'not-allowed' : 'pointer',
                                    boxShadow: isMe ? (isT1 ? '0 0 10px rgba(244,63,94,0.18)' : '0 0 10px rgba(14,165,233,0.18)') : 'none'
                                  }}>
                                  {isMe && (
                                    <span className="absolute -top-1.5 -right-1.5 text-[8px] bg-yellow-400 text-black font-black px-1 rounded-full leading-none py-0.5">أنت</span>
                                  )}
                                  <div className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-[11px] flex-shrink-0"
                                    style={{
                                      background: isMe ? (isT1 ? 'rgba(244,63,94,0.5)' : 'rgba(14,165,233,0.5)') : 'rgba(255,255,255,0.06)',
                                      border: isMe ? (isT1 ? '1.5px solid rgba(251,113,133,0.6)' : '1.5px solid rgba(56,189,248,0.6)') : '1.5px solid rgba(255,255,255,0.08)',
                                      color: isMe ? '#fff' : 'rgba(255,255,255,0.3)'
                                    }}>
                                    {isTaken ? (claimed as string).slice(0, 2) : isMe ? (playerName || "؟").slice(0, 2) : i + 1}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[11px] font-semibold truncate leading-tight"
                                      style={{ color: isMe ? '#fff' : isTaken ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.22)' }}>
                                      {isTaken ? claimed as string : isMe ? playerName : "فارغ"}
                                    </div>
                                    <div className={`text-[9px] font-bold leading-tight ${isT1 ? "text-rose-400/70" : "text-sky-400/70"}`}>
                                      {isT1 ? "العربي" : "السد"}
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* ── All players ready or bots filled ── */
                      <div className="text-center py-4 space-y-3">
                        <div className="text-5xl select-none opacity-40">🂠 🂠 🂠</div>
                        <p className="text-muted-foreground text-sm">اضغط "وزّع الكروت" لبدء الجولة</p>
                      </div>
                    )}

                    {/* Deal button always visible at bottom */}
                    <Button data-testid="button-deal-cards" onClick={handleDeal} disabled={botCountdown !== null} className="w-full" size="lg">
                      <Shuffle className="w-4 h-4 ml-2" />
                      {botCountdown !== null ? `انتظار اللاعبين... (${botCountdown}ث)` : "وزّع الكروت"}
                    </Button>
                  </div>
                ) : (
                  /* ── Cards dealt: hand first, then purchase controls ── */
                  <>
                    {/* Hand — two-row fan layout, all visible */}
                    {(() => {
                      const cardW = cardSizePref === "lg" ? 64 : cardSizePref === "sm" ? 40 : 56;
                      const cardH = cardSizePref === "lg" ? 100 : cardSizePref === "sm" ? 60 : 88;
                      const botCount = playerCount === 6 ? 5 : 7;
                      const botRow = myHand.slice(0, botCount);
                      const topRow = myHand.slice(botCount);
                      const renderFanRow = (cards: CardStr[]) => {
                        const cn = cards.length;
                        return (
                          <div className="relative w-full" style={{ height: cardH + 8 }}>
                            {cards.map((c, i) => {
                              const leftStyle = cn === 1
                                ? `calc(50% - ${cardW / 2}px)`
                                : `calc(${i} / ${cn - 1} * (100% - ${cardW + 8}px) + 4px)`;
                              return (
                                <div key={i} className="absolute" style={{ left: leftStyle, bottom: 2, zIndex: i + 1 }}>
                                  <PlayingCard card={c} size={cardSizePref} />
                                </div>
                              );
                            })}
                          </div>
                        );
                      };
                      return (
                        <div className="flex flex-col gap-1 w-full max-w-[420px] mx-auto">
                          {topRow.length > 0 && renderFanRow(topRow)}
                          {renderFanRow(botRow)}
                        </div>
                      );
                    })()}

                    {/* ── Card-reveal period: show cards only, no bid controls ── */}
                    {cardsJustDealt ? (
                      <div className="border-t border-border/30 pt-5 pb-2 flex flex-col items-center gap-4">
                        {/* Big countdown circle */}
                        <div className="relative flex items-center justify-center">
                          <svg className="w-20 h-20 -rotate-90" viewBox="0 0 64 64">
                            <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="5" />
                            <circle cx="32" cy="32" r="28" fill="none"
                              stroke={dealRevealTimer <= 1 ? "#ef4444" : "hsl(var(--primary))"}
                              strokeWidth="5" strokeLinecap="round"
                              strokeDasharray={`${2 * Math.PI * 28}`}
                              strokeDashoffset={`${2 * Math.PI * 28 * (1 - dealRevealTimer / 2)}`}
                              style={{ transition: "stroke-dashoffset 1s linear, stroke 0.3s" }} />
                          </svg>
                          <span className="absolute text-2xl font-black tabular-nums text-primary">{dealRevealTimer}</span>
                        </div>
                        <div className="text-center space-y-1">
                          <p className="text-sm font-bold text-foreground">راجع كروتك جيداً</p>
                          <p className="text-xs text-muted-foreground">الشراء يبدأ بعد {dealRevealTimer} {dealRevealTimer === 1 ? "ثانية" : "ثوانٍ"}</p>
                          {/* Show who bids first */}
                          {purchaseTurn !== -1 && (
                            <p className="text-xs mt-1">
                              <span className="text-muted-foreground">يبدأ الشراء: </span>
                              <span className={`font-semibold ${purchaseTurn % 2 === 0 ? "text-red-400" : "text-sky-300"}`}>
                                {purchaseTurn === myIndex ? "⭐ أنت أول من يشتري!" : players[purchaseTurn]?.name}
                              </span>
                            </p>
                          )}
                        </div>
                      </div>
                    ) : (

                    <div className="border-t border-border/30 pt-4 space-y-4">

                      {/* ── Overdue / forced-buy warnings ── */}
                      {(team0Overdue || team1Overdue) && !allSubmitted && (
                        <div className="space-y-1.5">
                          {team0Overdue && (
                            <div className="flex items-center gap-2 rounded-md bg-orange-500/10 border border-orange-500/30 px-2.5 py-1.5 text-xs text-orange-400">
                              <span>⚠️</span>
                              <span>فريق <strong>العربي</strong> لم يشترِ منذ {roundNumber - lastBuyRound[0]} جولة
                                {forcedBuyTeam === 0 ? " – مُجبَر على الشراء هذه الجولة!" : ` (الحد: ${buyThreshold})`}
                              </span>
                            </div>
                          )}
                          {team1Overdue && (
                            <div className="flex items-center gap-2 rounded-md bg-orange-500/10 border border-orange-500/30 px-2.5 py-1.5 text-xs text-orange-400">
                              <span>⚠️</span>
                              <span>فريق <strong>السد</strong> لم يشترِ منذ {roundNumber - lastBuyRound[1]} جولة
                                {forcedBuyTeam === 1 ? " – مُجبَر على الشراء هذه الجولة!" : ` (الحد: ${buyThreshold})`}
                              </span>
                            </div>
                          )}
                          {forcedBuyTeam !== null && (
                            <div className="flex items-center gap-2 rounded-md bg-yellow-500/10 border border-yellow-500/30 px-2.5 py-1.5 text-xs text-yellow-400">
                              <span>🔒</span>
                              <span>جولة شراء إجبارية – فريق <strong>{forcedBuyTeam === 0 ? "العربي" : "السد"}</strong> فقط يشتري هذه الجولة</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* ── Sequential purchase UI ── */}
                      {(() => {
                        const maxT = playerCount === 4 ? 13 : 9;
                        const bidLabel = (v: number) => v >= maxT ? "لورنس" : String(v);
                        // Ordered list for bid list: forced team first, then auto-0 non-forced team
                        const allSeatsOrdered = purchaseOrder.length > 0
                          ? purchaseOrder
                          : Array.from({ length: playerCount }, (_, i) => i);
                        const nonForcedSeats = forcedBuyTeam !== null
                          ? Array.from({ length: playerCount }, (_, i) => i).filter(s => s % 2 !== forcedBuyTeam)
                          : [];
                        const orderedSeats = [...allSeatsOrdered, ...nonForcedSeats];

                        return (
                          <div className="space-y-4">

                            {/* Unified purchase view: each player only controls their own bid */}
                            {purchaseTurn === myIndex ? (
                                <div className={`rounded-lg border-2 p-4 space-y-3 ${isTeam1 ? "border-red-500/40 bg-red-500/5" : "border-zinc-500/40 bg-zinc-700/10"}`}>
                                  <div className="flex items-center justify-between">
                                    <div>
                                      <div className="font-bold text-base">{players[myIndex]?.name}</div>
                                      <div className={`text-xs ${isTeam1 ? "text-red-400" : "text-zinc-400"}`}>{isTeam1 ? "فريق العربي" : "فريق السد"}</div>
                                    </div>
                                    <Badge variant="secondary" className="text-xs text-yellow-400 border-yellow-400/30 animate-pulse">دورك الآن!</Badge>
                                  </div>
                                  {/* Circular timer only */}
                                  {purchaseTimer !== null && (
                                    <div className="flex items-center gap-3">
                                      <div className="relative flex-shrink-0 flex items-center justify-center">
                                        <svg className="w-12 h-12 -rotate-90" viewBox="0 0 56 56">
                                          <circle cx="28" cy="28" r="24" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
                                          <circle cx="28" cy="28" r="24" fill="none"
                                            stroke={purchaseTimer <= 5 ? "#ef4444" : purchaseTimer <= 10 ? "#f59e0b" : "#22c55e"}
                                            strokeWidth="4" strokeLinecap="round"
                                            strokeDasharray={`${2 * Math.PI * 24}`}
                                            strokeDashoffset={`${2 * Math.PI * 24 * (1 - purchaseTimer / 20)}`}
                                            style={{ transition: "stroke-dashoffset 1s linear, stroke 0.3s" }} />
                                        </svg>
                                        <span className={`absolute text-sm font-black tabular-nums ${purchaseTimer <= 5 ? "text-red-400" : purchaseTimer <= 10 ? "text-yellow-400" : "text-green-400"}`}>{purchaseTimer}</span>
                                      </div>
                                      {purchaseTimer <= 7 && <p className="text-xs text-red-400 animate-pulse">⚠ سيُرسل شرائك تلقائياً!</p>}
                                    </div>
                                  )}
                                  <div className="text-sm text-muted-foreground">كم تريد أن تشتري؟</div>
                                  <div className="flex items-center gap-3">
                                    <button onClick={() => { const mb = playerCount === 4 ? 2 : 1; setMyDraft((v) => Math.max(mb, v - 1)); }} className={`w-12 h-12 rounded-lg border flex items-center justify-center text-2xl font-bold hover-elevate ${isTeam1 ? "border-red-500/30 bg-red-500/10 text-red-400" : "border-zinc-500/30 bg-zinc-700/20 text-zinc-300"}`}>−</button>
                                    <div className={`flex-1 h-14 rounded-lg border-2 flex items-center justify-center text-3xl font-bold ${isTeam1 ? "border-red-500/40 text-red-300" : "border-zinc-500/40 text-zinc-200"}`}>
                                      {myDraft >= maxT ? <span className="text-yellow-400 text-2xl">لورنس</span> : myDraft}
                                    </div>
                                    <button onClick={() => setMyDraft((v) => Math.min(maxT, v + 1))} className={`w-12 h-12 rounded-lg border flex items-center justify-center text-2xl font-bold hover-elevate ${isTeam1 ? "border-red-500/30 bg-red-500/10 text-red-400" : "border-zinc-500/30 bg-zinc-700/20 text-zinc-300"}`}>+</button>
                                  </div>
                                  <Button data-testid="button-submit-purchase" onClick={handleSubmitPurchase} disabled={gameOver} className={`w-full ${isTeam1 ? "" : "bg-zinc-700 hover:bg-zinc-600 text-zinc-100 border-zinc-600"}`} variant={isTeam1 ? "default" : "outline"}>
                                    <CheckCircle2 className="w-4 h-4 ml-2" />أرسل شرائي ({myDraft >= maxT ? "لورنس" : myDraft})
                                  </Button>
                                </div>
                              ) : (
                                /* Waiting for another player */
                                <div className="rounded-lg border border-border/30 bg-muted/10 p-4 text-center space-y-2">
                                  {forcedBuyTeam !== null && (isTeam1 ? 0 : 1) !== forcedBuyTeam ? (
                                    /* Non-forced team: locked out this round */
                                    <>
                                      <div className="text-2xl">🔒</div>
                                      <div className="text-sm font-semibold text-orange-400">فريقك لا يشتري هذه الجولة</div>
                                      <div className="text-xs text-muted-foreground">تم إرسال شرائك تلقائيًا بـ 0</div>
                                    </>
                                  ) : mySubmitted ? (
                                    <>
                                      <div className={`text-4xl font-bold ${isTeam1 ? "text-red-400" : "text-zinc-300"}`}>
                                        {(submittedPurchases[myIndex] ?? 0) >= maxT
                                          ? <span className="text-yellow-400 text-3xl">لورنس</span>
                                          : submittedPurchases[myIndex]}
                                      </div>
                                      <div className="text-xs text-green-400 flex items-center justify-center gap-1">
                                        <CheckCircle2 className="w-3.5 h-3.5" />أرسلت شرائك
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      {purchaseTurn !== -1 && (
                                        <div className="text-sm font-semibold text-yellow-300 animate-pulse">
                                          {players[purchaseTurn]?.name} يختار الآن
                                        </div>
                                      )}
                                      {/* Shared bid timer — simple number */}
                                      {purchaseTimer !== null && purchaseTurn !== -1 && (
                                        <div className={`text-sm font-bold tabular-nums mt-1 ${purchaseTimer <= 5 ? "text-red-400" : purchaseTimer <= 10 ? "text-yellow-400" : "text-green-400"}`}>
                                          ⏱ {purchaseTimer}ث
                                        </div>
                                      )}
                                    </>
                                  )}
                                </div>
                              )
                            }

                            {/* Sequential bid list — shows all in purchase order */}
                            <div className="space-y-1.5">
                              <div className="text-xs text-muted-foreground font-medium mb-1 flex items-center justify-between">
                                <span>ترتيب الشراء</span>
                                <span className="text-[10px] opacity-60">{submittedPurchases.filter(v => v !== null).length}/{playerCount} أكملوا</span>
                              </div>
                              {orderedSeats.map((seat, orderIdx) => {
                                const p = players[seat];
                                const isT1 = seat % 2 === 0;
                                const isMe = seat === myIndex;
                                const bid = submittedPurchases[seat];
                                const isCurrent = seat === purchaseTurn;
                                const isDone = bid !== null;
                                const isPending = !isDone && !isCurrent;
                                const isAutoLocked = forcedBuyTeam !== null && seat % 2 !== forcedBuyTeam;
                                return (
                                  <div key={seat} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-all
                                    ${isAutoLocked ? "border-border/10 opacity-40" : isCurrent ? "border-yellow-400/60 bg-yellow-400/8 shadow-sm" : isDone ? "border-border/20 bg-muted/5" : "border-border/10 opacity-60"}`}>
                                    <span className="text-xs text-muted-foreground w-4 text-center font-mono">{orderIdx + 1}</span>
                                    {isAutoLocked
                                      ? <span className="text-xs flex-shrink-0">🔒</span>
                                      : isCurrent
                                        ? <Clock className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0 animate-pulse" />
                                        : isDone
                                          ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                                          : <div className="w-3.5 h-3.5 rounded-full border border-border/40 flex-shrink-0" />}
                                    <span className={`flex-1 text-xs font-medium truncate ${isMe ? "font-bold" : ""} ${isT1 ? "text-red-300" : "text-zinc-300"}`}>
                                      {p?.name}{isMe ? " (أنت)" : ""}{botSeats.has(seat) ? " 🤖" : ""}
                                    </span>
                                    <span className={`text-sm font-black min-w-[36px] text-right ${isAutoLocked ? "text-muted-foreground" : isDone ? (isT1 ? "text-red-400" : "text-sky-400") : isCurrent ? "text-yellow-400" : "text-muted-foreground/40"}`}>
                                      {isAutoLocked ? "0" : isDone ? bidLabel(bid!) : isCurrent ? "…" : ""}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Team totals — compact inline bar */}
                      {(() => {
                        const totalTricks = playerCount === 4 ? 13 : 9;
                        const t1Total = submittedPurchases.filter((_, i) => i % 2 === 0).reduce<number>((a, v) => a + (v ?? 0), 0);
                        const t2Total = submittedPurchases.filter((_, i) => i % 2 !== 0).reduce<number>((a, v) => a + (v ?? 0), 0);
                        const t1Lawrence = t1Total >= totalTricks;
                        const t2Lawrence = t2Total >= totalTricks;
                        return (
                          <div className="flex items-center gap-2 pt-2 border-t border-border/20">
                            <div className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-red-500/8 border border-red-500/20">
                              <span className="text-[10px] text-red-400/70 font-medium">العربي</span>
                              <span className={`text-lg font-black ${t1Lawrence ? "text-yellow-400" : "text-red-400"}`}>
                                {t1Lawrence ? "⚡" : ""}{t1Total}
                              </span>
                              {t1Lawrence && <span className="text-[10px] text-yellow-400 font-bold">لورنس</span>}
                            </div>
                            <span className="text-muted-foreground/40 text-xs font-bold">vs</span>
                            <div className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-sky-500/8 border border-sky-500/20">
                              <span className="text-[10px] text-sky-400/70 font-medium">السد</span>
                              <span className={`text-lg font-black ${t2Lawrence ? "text-yellow-400" : "text-sky-400"}`}>
                                {t2Lawrence ? "⚡" : ""}{t2Total}
                              </span>
                              {t2Lawrence && <span className="text-[10px] text-yellow-400 font-bold">لورنس</span>}
                            </div>
                          </div>
                        );
                      })()}

                      <Button data-testid="button-next-round" onClick={handleNextRound} disabled={gameOver || (!isHost && !allSubmitted)} className="w-full">
                        <ChevronRight className="w-4 h-4 ml-1.5" />
                        {allSubmitted || isHost ? "تأكيد الجولة" : `انتظار اللاعبين (${submittedCount}/${playerCount})`}
                      </Button>
                    </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Table Layout (purchase + playing phases + inter-round) ── */}
          {!gameOver && (playingPhase || myHand.length > 0 || inGameSession) && (() => {
            const bottomSeat = myIndex;
            const ledSuit = playingPhase && trickCards.length > 0 ? cardSuit(trickCards[0].card) : null;
            const validHand = playingPhase ? validCards(myHand, ledSuit, blackJokerPlayed, trickCards.some((e) => e.card === JOKER_B)) : [];
            const totalTricks = playerCount === 4 ? 13 : 9;
            const t1Won = tricksWon.filter((_, i) => i % 2 === 0).reduce((a, v) => a + v, 0);
            const t2Won = tricksWon.filter((_, i) => i % 2 !== 0).reduce((a, v) => a + v, 0);
            const t1Bid = submittedPurchases.filter((_, i) => i % 2 === 0).reduce<number>((a, v) => a + (v ?? 0), 0);
            const t2Bid = submittedPurchases.filter((_, i) => i % 2 !== 0).reduce<number>((a, v) => a + (v ?? 0), 0);
            const t1Lawrence = t1Bid >= totalTricks;
            const t2Lawrence = t2Bid >= totalTricks;
            // direction d: seat = (bottomSeat + d) % playerCount
            const seatAt = (d: number) => (bottomSeat + d) % playerCount;
            const dirOf = (pi: number) => (pi - bottomSeat + playerCount) % playerCount;

            // Positions for trick cards WITHIN the center area
            // All devices: d0=bottom(me), d2=top(opponent)
            const trickPos4: CSSProperties[] = [
              { position: 'absolute', bottom: 4, left: '50%', transform: 'translateX(-50%)' },
              { position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' },
              { position: 'absolute', top: 4, left: '50%', transform: 'translateX(-50%)' },
              { position: 'absolute', left: 4, top: '50%', transform: 'translateY(-50%)' },
            ];
            const trickPos4Mobile = trickPos4;
            // 6-player: hexagonal layout — all devices: d0=bottom-center(me), d3=top-center
            const trickPos6: CSSProperties[] = [
              { position: 'absolute', left: 90,  top: 140 }, // d0 bottom-center (me)
              { position: 'absolute', left: 168, top: 100 }, // d1 bottom-right
              { position: 'absolute', left: 168, top: 22  }, // d2 top-right
              { position: 'absolute', left: 90,  top: 5   }, // d3 top-center
              { position: 'absolute', left: 12,  top: 22  }, // d4 top-left
              { position: 'absolute', left: 12,  top: 100 }, // d5 bottom-left
            ];
            const trickPos6Mobile = trickPos6;
            const trickPositions = playerCount === 4
              ? (isMobile ? trickPos4Mobile : trickPos4)
              : (isMobile ? trickPos6Mobile : trickPos6);
            const trickCardSize = playerCount === 6 ? "sm" : "md";

            const renderTrickCard = (_pi: number, card: CardStr) => {
              return (
                <div>
                  <PlayingCard card={card} size={trickCardSize} />
                </div>
              );
            };

            // Render a circular player avatar slot for the table edge
            const renderTablePlayer = (pi: number) => {
              const p = players[pi];
              if (!p) return null;
              const isT1 = pi % 2 === 0;
              const isActive = currentTurn === pi;
              const myTricks = tricksWon[pi] ?? 0;
              const isMe = pi === myIndex;
              const cardsLeft = isMe ? myHand.length : (botHandsRef.current[pi]?.length ?? (playerCount === 4 ? 13 : 9));

              // Mini card stack
              const stackW = 54;
              const cardW = 11;
              const cardH = 15;
              const cardBg = isT1
                ? 'linear-gradient(145deg,#7f1d1d 0%,#b91c1c 45%,#7f1d1d 100%)'
                : 'linear-gradient(145deg,#18181b 0%,#3f3f46 45%,#18181b 100%)';

              const bidVal = submittedPurchases[pi];
              const maxT = playerCount === 4 ? 13 : 9;
              const hasBid = bidVal !== null && bidVal !== undefined;
              const isBiddingTurn = !playingPhase && purchaseTurn === pi;

              return (
                <div className="flex flex-col items-center gap-0.5">
                  {/* Top area: card stack during play / bid bubble during purchasing */}
                  {playingPhase ? (
                    <div className="relative flex-shrink-0" style={{ width: stackW, height: cardH + 3 }}>
                      {cardsLeft > 0
                        ? Array.from({ length: cardsLeft }).map((_, i) => {
                            const leftPx = cardsLeft === 1
                              ? (stackW - cardW) / 2
                              : (i / (cardsLeft - 1)) * (stackW - cardW);
                            return (
                              <div key={i} className="absolute"
                                style={{
                                  left: leftPx,
                                  top: i % 2 === 0 ? 0 : 1,
                                  width: cardW,
                                  height: cardH,
                                  background: cardBg,
                                  borderRadius: 2,
                                  border: '1px solid rgba(255,255,255,0.35)',
                                  boxShadow: '0 1px 2px rgba(0,0,0,0.5)',
                                  zIndex: i + 1,
                                }}
                              />
                            );
                          })
                        : <div className="text-[8px] text-white/25 w-full text-center mt-1">—</div>
                      }
                    </div>
                  ) : (
                    /* Purchasing phase: show bid value bubble or waiting dots */
                    <div className="flex items-center justify-center" style={{ height: cardH + 3 }}>
                      {hasBid ? (
                        <div className="px-2 py-0.5 rounded-full flex items-center gap-1"
                          style={{
                            background: isT1 ? 'rgba(220,38,38,0.85)' : 'rgba(14,165,233,0.85)',
                            border: `1.5px solid ${isT1 ? 'rgba(248,113,113,0.7)' : 'rgba(56,189,248,0.7)'}`,
                            boxShadow: isT1 ? '0 0 8px rgba(220,38,38,0.4)' : '0 0 8px rgba(14,165,233,0.4)',
                          }}>
                          <span className="text-white/70 text-[8px] font-semibold leading-none">🛒</span>
                          <span className="text-white font-black text-[11px] leading-none tabular-nums">
                            {bidVal! >= maxT ? "لورنس" : bidVal}
                          </span>
                        </div>
                      ) : isBiddingTurn ? (
                        <div className="flex gap-0.5 items-center">
                          {[0,1,2].map(d => (
                            <span key={d} className="w-1 h-1 rounded-full bg-yellow-400"
                              style={{ animation: `pulse 1s ease-in-out ${d * 0.2}s infinite` }} />
                          ))}
                        </div>
                      ) : (
                        <span className="text-white/20 text-[9px]">—</span>
                      )}
                    </div>
                  )}

                  {/* Avatar circle */}
                  <div className={`relative w-12 h-12 rounded-full flex items-center justify-center font-bold text-sm shadow-lg transition-all${offlineSeats.has(pi) ? " opacity-45" : ""}`}
                    style={{
                      background: trickWinnerBanner === pi
                        ? 'linear-gradient(135deg,#a16207,#ca8a04)'
                        : isActive
                          ? isT1 ? 'linear-gradient(135deg,#7f1d1d,#dc2626)' : 'linear-gradient(135deg,#0c4a6e,#0284c7)'
                          : isT1 ? 'linear-gradient(135deg,#450a0a,#7f1d1d)' : 'linear-gradient(135deg,#09090b,#27272a)',
                      border: trickWinnerBanner === pi
                        ? '2.5px solid #fde047'
                        : isActive
                          ? isT1 ? '2.5px solid rgba(248,113,113,0.9)' : '2.5px solid rgba(56,189,248,0.9)'
                          : isT1 ? '2px solid rgba(220,38,38,0.45)' : '2px solid rgba(113,113,122,0.4)',
                      boxShadow: trickWinnerBanner === pi
                        ? '0 0 16px rgba(250,204,21,0.6)'
                        : isActive
                          ? isT1 ? '0 0 12px rgba(220,38,38,0.45)' : '0 0 12px rgba(14,165,233,0.45)'
                          : '0 2px 8px rgba(0,0,0,0.6)',
                      color: '#fff',
                    }}>
                    {isMe ? <span className="text-base leading-none">{playerIcon}</span> : p.name.slice(0, 2)}
                    {trickWinnerBanner === pi && <span className="absolute inset-0 rounded-full border-2 border-yellow-300 animate-ping opacity-60" />}
                    {isActive && !trickWinnerBanner && <span className="absolute inset-0 rounded-full border-2 border-yellow-400 animate-ping opacity-40" />}
                    {/* Individual trick count badge (playing phase) */}
                    {playingPhase && (
                      <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-extrabold shadow"
                        style={{
                          background: isT1 ? 'rgba(220,38,38,0.9)' : 'rgba(14,165,233,0.9)',
                          border: '1.5px solid rgba(255,255,255,0.3)',
                          color: '#fff',
                        }}>
                        {myTricks}
                      </span>
                    )}
                    {/* Connection status dot */}
                    {!isMe && inGameSession && (
                      <span className={`absolute -bottom-0.5 -left-0.5 w-3 h-3 rounded-full border-2 border-black ${offlineSeats.has(pi) ? "bg-red-500" : "bg-emerald-400"}`} title={offlineSeats.has(pi) ? "غير متصل" : "متصل"} />
                    )}
                  </div>
                  {/* Name label */}
                  <div className="px-1.5 py-0.5 rounded-full text-[8px] font-semibold whitespace-nowrap" style={{
                    background: isActive ? 'rgba(250,204,21,0.18)' : 'rgba(0,0,0,0.55)',
                    border: isActive ? '1px solid rgba(250,204,21,0.35)' : '1px solid rgba(255,255,255,0.08)',
                    color: isActive ? '#fde047' : 'rgba(255,255,255,0.65)',
                  }}>
                    {p.name}{botSeats.has(pi) ? " 🤖" : ""}
                  </div>
                </div>
              );
            };



            return (
              <div className="flex-1 flex flex-col overflow-hidden min-h-0" style={{ background: 'linear-gradient(160deg, #0a160b 0%, #0d1a0e 100%)' }}>

                {/* ── Main table area ── */}
                <div className="relative flex-1 overflow-hidden min-h-0">


                  {/* ── Trick counter — top center (playing phase) ── */}
                  {playingPhase && (
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-0.5">
                      <div className="text-[10px] text-white/60 bg-black/50 rounded-full px-2.5 py-0.5 border border-white/10">
                        {trickNumber < totalTricks ? `ورقة ${trickNumber + 1}/${totalTricks}` : "النتيجة…"}
                      </div>
                      {lastTrickForfeited && (
                        <div className="text-red-400 font-bold animate-pulse text-[9px]">⚠ خسارة الطلعة!</div>
                      )}
                      {lastTrickWinner !== null && !lastTrickForfeited && trickCards.length === 0 && (
                        <div className="text-yellow-300 text-[9px]">فاز: {players[lastTrickWinner]?.name}</div>
                      )}
                    </div>
                  )}

                  {/* ── Bid corner boxes — visible all round once any bid submitted ── */}
                  {submittedPurchases.some(b => b !== null) && (() => {
                    const _ttl  = playerCount === 4 ? 13 : 9;
                    const _t1B  = submittedPurchases.filter((_, i) => i % 2 === 0).reduce<number>((a, v) => a + (v ?? 0), 0);
                    const _t2B  = submittedPurchases.filter((_, i) => i % 2 !== 0).reduce<number>((a, v) => a + (v ?? 0), 0);
                    const _t1W  = tricksWon.filter((_, i) => i % 2 === 0).reduce((a, v) => a + v, 0);
                    const _t2W  = tricksWon.filter((_, i) => i % 2 !== 0).reduce((a, v) => a + v, 0);
                    const _t1L  = _t1B >= _ttl;
                    const _t2L  = _t2B >= _ttl;
                    const _t1Ok = playingPhase && _t1W >= _t1B && !_t1L;
                    const _t2Ok = playingPhase && _t2W >= _t2B && !_t2L;

                    const boxStyle: React.CSSProperties = {
                      background: 'rgba(0,0,0,0.72)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      backdropFilter: 'blur(8px)',
                      borderRadius: 10,
                    };

                    return <>
                      {/* العربي — top RIGHT */}
                      <div className="absolute top-2 right-2 z-30 flex flex-col items-center px-2.5 py-1.5 min-w-[48px]" style={boxStyle}>
                        <span className="text-[8px] font-bold text-red-400/90 leading-none mb-1">العربي</span>
                        {playingPhase ? (
                          <span className={`text-lg font-black leading-none tabular-nums ${_t1L ? "text-yellow-300" : _t1Ok ? "text-green-300" : "text-red-300"}`}>
                            {_t1W}<span className="text-[11px] font-normal text-white/35">/{_t1B}</span>
                            {_t1L && <span className="text-[10px] ml-0.5">⚡</span>}
                            {_t1Ok && <span className="text-green-400 text-[10px] ml-0.5">✓</span>}
                          </span>
                        ) : (
                          <span className="text-lg font-black leading-none tabular-nums text-red-300">{_t1B}</span>
                        )}
                      </div>

                      {/* السد — top LEFT */}
                      <div className="absolute top-2 left-2 z-30 flex flex-col items-center px-2.5 py-1.5 min-w-[48px]" style={boxStyle}>
                        <span className="text-[8px] font-bold text-sky-400/90 leading-none mb-1">السد</span>
                        {playingPhase ? (
                          <span className={`text-lg font-black leading-none tabular-nums ${_t2L ? "text-yellow-300" : _t2Ok ? "text-green-300" : "text-sky-300"}`}>
                            {_t2W}<span className="text-[11px] font-normal text-white/35">/{_t2B}</span>
                            {_t2L && <span className="text-[10px] ml-0.5">⚡</span>}
                            {_t2Ok && <span className="text-green-400 text-[10px] ml-0.5">✓</span>}
                          </span>
                        ) : (
                          <span className="text-lg font-black leading-none tabular-nums text-sky-300">{_t2B}</span>
                        )}
                      </div>
                    </>;
                  })()}

                  {/* ── The dark-red table ── */}
                  {/* Outer wrapper: handles player positioning (overflow-visible so avatars hang outside) */}
                  <div className="absolute overflow-visible" style={{
                    top: isMobile ? '10%' : '14%',
                    left: isMobile ? 'max(6%, 28px)' : 'max(10%, 48px)',
                    right: isMobile ? 'max(6%, 28px)' : 'max(10%, 48px)',
                    bottom: isHost ? (isMobile ? '4%' : '6%') : (isMobile ? '10%' : '14%'),
                  }}>
                    {/* Inner visual shape: hexagon for 6p, oval/rect for 4p */}
                    <div className="absolute inset-0 pointer-events-none" style={{
                      background: 'linear-gradient(160deg, #1a4a20 0%, #0f2e14 40%, #091c0c 100%)',
                      borderRadius: playerCount === 6 ? 0 : (tableShape === 'oval' ? '50%' : 24),
                      clipPath: playerCount === 6 ? 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)' : 'none',
                      border: '3px solid rgba(80,140,60,0.20)',
                      boxShadow: '0 12px 60px rgba(0,0,0,0.9), inset 0 1px 0 rgba(120,200,80,0.06), 0 0 0 6px rgba(40,70,30,0.18)',
                    }} />

                    {/* ── 4-player seat positions ── */}
                    {/* All devices: me(d0) at bottom, opponent(d2) at top */}
                    {playerCount === 4 && <>
                      {/* Top: always opponent (d2) */}
                      <div className="absolute left-1/2 -translate-x-1/2" style={{ top: -50 }}>
                        {renderTablePlayer(seatAt(2))}
                      </div>
                      {/* Right */}
                      <div className="absolute top-1/2 -translate-y-1/2" style={{ right: -44 }}>
                        {renderTablePlayer(seatAt(1))}
                      </div>
                      {/* Left */}
                      <div className="absolute top-1/2 -translate-y-1/2" style={{ left: -44 }}>
                        {renderTablePlayer(seatAt(3))}
                      </div>
                    </>}

                    {/* ── 6-player seat positions (hexagonal — alternating teams clockwise) ── */}
                    {/* All devices: me(d0) at bottom, opponent(d3) at top */}
                    {playerCount === 6 && <>
                      {/* Top-center: always d3 */}
                      <div className="absolute left-1/2 -translate-x-1/2" style={{ top: -50 }}>
                        {renderTablePlayer(seatAt(3))}
                      </div>
                      {/* Top-right (d=2) — upper-right edge of hexagon */}
                      <div className="absolute" style={{ top: '12%', right: isMobile ? -38 : -50 }}>
                        {renderTablePlayer(seatAt(2))}
                      </div>
                      {/* Bottom-right (d=1) — lower-right edge of hexagon */}
                      <div className="absolute" style={{ bottom: '12%', right: isMobile ? -38 : -50 }}>
                        {renderTablePlayer(seatAt(1))}
                      </div>
                      {/* Top-left (d=4) — upper-left edge of hexagon */}
                      <div className="absolute" style={{ top: '12%', left: isMobile ? -38 : -50 }}>
                        {renderTablePlayer(seatAt(4))}
                      </div>
                      {/* Bottom-left (d=5) — lower-left edge of hexagon */}
                      <div className="absolute" style={{ bottom: '12%', left: isMobile ? -38 : -50 }}>
                        {renderTablePlayer(seatAt(5))}
                      </div>
                    </>}

                    {/* Center: dealing indicator OR purchase status OR trick cards */}
                    <div className="absolute inset-0 flex items-center justify-center">
                      {!playingPhase && myHand.length === 0 ? (
                        /* Inter-round: dealing in progress */
                        <div className="text-white/30 text-sm animate-pulse">جارٍ التوزيع…</div>
                      ) : !playingPhase ? (
                        /* Purchase phase: full bid summary in center of table */
                        <div className="flex flex-col items-center gap-2 w-full px-4" style={{ maxWidth: isMobile ? 200 : 240 }}>
                          {/* Header */}
                          {purchaseTurn === myIndex && (
                            <div className="text-yellow-300 text-[11px] font-black animate-pulse tracking-wide" style={{ textShadow: '0 0 8px rgba(253,224,71,0.6)' }}>
                              🎯 دورك أنت الآن!
                            </div>
                          )}
                          <div className="text-white/35 text-[9px] font-semibold">الشراء – جولة {roundNumber + 1}</div>
                          {/* Bid rows */}
                          <div className="flex flex-col gap-1.5 w-full">
                            {purchaseOrder.map((pi) => {
                              const submitted = submittedPurchases[pi] !== null;
                              const val = submittedPurchases[pi];
                              const isT1 = pi % 2 === 0;
                              const isCurrent = pi === purchaseTurn;
                              const isMe = pi === myIndex;
                              const isTeammate = pi !== myIndex && pi % 2 === myIndex % 2;
                              const maxT = playerCount === 4 ? 13 : 9;
                              return (
                                <div key={pi}
                                  className={`flex items-center justify-between gap-2 px-2 py-1 rounded-lg border transition-all duration-300 ${
                                    isCurrent
                                      ? "border-yellow-400/70 bg-yellow-900/40"
                                      : submitted
                                        ? isTeammate
                                          ? "border-green-500/40 bg-green-900/25"
                                          : isMe
                                            ? "border-blue-400/40 bg-blue-900/25"
                                            : "border-zinc-600/30 bg-zinc-800/30"
                                        : "border-white/5 bg-transparent opacity-30"
                                  }`}>
                                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isT1 ? "bg-red-400" : "bg-sky-400"}`} />
                                  <span className={`text-[10px] font-semibold flex-1 ${isCurrent ? "text-yellow-200" : submitted ? "text-white/80" : "text-white/30"}`}>
                                    {players[pi]?.name ?? `لاعب ${pi + 1}`}
                                    {isMe ? " (أنت)" : isTeammate ? " 🤝" : ""}
                                  </span>
                                  {submitted
                                    ? <span className={`text-[13px] font-black flex-shrink-0 ${isT1 ? "text-red-300" : "text-sky-300"}`}>
                                        {val! >= maxT ? "لورنس" : val}
                                      </span>
                                    : isCurrent
                                      ? <span className="text-yellow-400 animate-pulse text-[10px] font-bold flex-shrink-0">◀</span>
                                      : <span className="text-white/15 text-[9px] flex-shrink-0">···</span>
                                  }
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : trickCards.length === 0 ? (
                        <div className="flex flex-col items-center gap-1.5">
                          <div className="text-white/20 text-sm text-center px-4">
                            {`دور ${players[currentTurn]?.name ?? ""}${currentTurn === myIndex && !isHost ? " (أنت)" : ""}`}
                          </div>
                          {lastTrickCards.length > 0 && (
                            <button data-testid="button-show-last-trick"
                              onClick={() => setShowLastTrickOverlay(true)}
                              className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/5 hover:bg-white/10 active:scale-95 transition-all border border-white/10 text-white/30 hover:text-white/50 text-[9px] font-medium">
                              <History className="w-2.5 h-2.5" />الأكلة الأخيرة
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="relative" style={{ width: playerCount === 6 ? 220 : 190, height: playerCount === 6 ? 205 : 165 }}>
                          {trickCards.map(({ pi, card }) => {
                            const d = dirOf(pi);
                            const pos = trickPositions[d] ?? { position: 'absolute', top: '30%', left: '30%' };
                            return (
                              <div key={pi} style={pos}>
                                {renderTrickCard(pi, card)}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Winner label only — no arrow */}
                    {trickAnimating && trickCards.length === playerCount && !lastTrickForfeited && (() => {
                      const winnerPi = trickWinner(trickCards);
                      const winnerName = players[winnerPi]?.name ?? "";
                      return (
                        <div className="absolute inset-0 flex items-end justify-center pb-2 z-20 pointer-events-none">
                          <span className="text-yellow-300 text-[10px] font-bold bg-black/60 rounded-full px-2 py-0.5 border border-yellow-400/40">
                            {winnerName} أخذ الأكلة!
                          </span>
                        </div>
                      );
                    })()}

                    {/* My seat: always at bottom on all devices */}
                    <div className="absolute left-1/2 -translate-x-1/2" style={{ bottom: isMobile ? -42 : -50 }}>
                      {renderTablePlayer(seatAt(0))}
                    </div>
                  </div>
                </div>

                {/* ── Bottom panel: hand cards (purchase + playing) ── */}
                {(playingPhase || (!playingPhase && myHand.length > 0)) && (
                  <div className="flex-shrink-0 flex flex-col" style={{ height: cardSizePref === 'lg' ? 'min(240px,46vh)' : cardSizePref === 'sm' ? 'min(150px,34vh)' : 'min(210px,44vh)' }}>
                    <div className="mx-2 flex-1 rounded-t-2xl relative" style={{ background: 'rgba(8,14,9,0.80)', overflow: playingPhase ? 'visible' : 'hidden' }}>

                      {/* ── Purchase phase: reveal countdown + card grid ── */}
                      {!playingPhase && (
                        <>
                          {cardsJustDealt && (
                            <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-3 py-1.5 gap-2"
                              style={{ background: 'rgba(10,18,12,0.95)', backdropFilter: 'blur(8px)', borderBottom: '1px solid rgba(14,165,233,0.2)' }}>
                              <div className="min-w-0">
                                <div className="text-xs font-bold text-sky-300">👀 راجع كروتك</div>
                                {purchaseTurn !== -1 && (
                                  <div className="text-[10px] text-white/45 mt-0.5">يبدأ الشراء: <span className={`font-semibold ${purchaseTurn % 2 === 0 ? "text-rose-400" : "text-sky-400"}`}>{purchaseTurn === myIndex ? "⭐ أنت أول!" : players[purchaseTurn]?.name}</span></div>
                                )}
                              </div>
                              <div className="relative flex-shrink-0 flex items-center justify-center">
                                <svg className="w-10 h-10 -rotate-90" viewBox="0 0 40 40">
                                  <circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3.5" />
                                  <circle cx="20" cy="20" r="16" fill="none"
                                    stroke={dealRevealTimer <= 1 ? "#ef4444" : "hsl(var(--primary))"}
                                    strokeWidth="3.5" strokeLinecap="round"
                                    strokeDasharray={`${2 * Math.PI * 16}`}
                                    strokeDashoffset={`${2 * Math.PI * 16 * (1 - dealRevealTimer / 2)}`}
                                    style={{ transition: "stroke-dashoffset 1s linear, stroke 0.3s" }} />
                                </svg>
                                <span className="absolute text-xs font-black tabular-nums text-primary">{dealRevealTimer}</span>
                              </div>
                            </div>
                          )}
                          {showDealHand && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 pointer-events-none select-none z-10">
                              <div style={{ fontSize: 40, animation: 'dealerHandSweep 1.1s ease-in-out 2 both', display: 'inline-block', transformOrigin: 'bottom center' }}>🤚</div>
                              <div className="text-xs text-sky-600 font-bold animate-pulse">يتم توزيع الأوراق…</div>
                            </div>
                          )}
                          <div key={`deal-${dealEpoch}`} className="flex flex-wrap gap-1.5 justify-center content-start p-2 pt-8 overflow-auto h-full">
                            {myHand.map((card, idx) => (
                              <div key={card} className="card-deal-in" style={{ animationDelay: `${idx * 80}ms` }}>
                                <PlayingCard card={card} size={cardSizePref === 'lg' ? 'md' : 'sm'} />
                              </div>
                            ))}
                          </div>
                        </>
                      )}

                      {/* ── Playing phase: two-row layout ── */}
                      {playingPhase && myHand.length > 0 ? (() => {
                        const cardW = cardSizePref === "lg" ? 64 : cardSizePref === "sm" ? 40 : 56;
                        const botCount = playerCount === 6 ? 5 : 7;
                        const displayedHand = handSortMode === "rank" ? sortHandByRank(myHand) : myHand;
                        const botRow = displayedHand.slice(0, botCount);
                        const topRow = displayedHand.slice(botCount);

                        const renderRow = (cards: CardStr[], startIdx: number) => {
                          const cn = cards.length;
                          return cards.map((card, i) => {
                            const canPlay = currentTurn === myIndex && !trickAnimating && validHand.includes(card);
                            const isHinted = showHint && hintCard === card && canPlay;
                            const isTrumpCard = card !== JOKER_B && card !== JOKER_R && card.endsWith("♠");
                            const leftStyle = cn === 1
                              ? `calc(50% - ${cardW / 2}px)`
                              : `calc(${i} / ${cn - 1} * (100% - ${cardW + 8}px) + 4px)`;
                            return (
                              <div key={card}
                                className="absolute card-deal-in"
                                style={{ left: leftStyle, bottom: 2, zIndex: i + 1, animationDelay: `${(startIdx + i) * 50}ms` }}>
                                <div data-testid={`card-hand-${card}`}
                                  className={`transition-transform${isHinted ? " hint-pulsing" : ""}${isTrumpCard ? " rounded-xl" : ""}`}
                                  style={{
                                    transitionDuration: `${animDurationMs}ms`,
                                    transform: isHinted ? "translateY(-14px) scale(1.08)" : canPlay ? "translateY(-5px)" : "translateY(0)",
                                    ...(isTrumpCard ? { boxShadow: '0 0 0 2px #f59e0b, 0 0 8px 2px rgba(245,158,11,0.4)' } : {}),
                                  }}>
                                  <PlayingCard card={card} size={cardSizePref} active={canPlay} dim={!canPlay}
                                    onClick={canPlay ? () => handlePlayCard(card) : undefined} />
                                </div>
                              </div>
                            );
                          });
                        };

                        return (
                          <div key={`play-deal-${dealEpoch}`} className="flex flex-col h-full gap-0 w-full max-w-[420px] mx-auto">
                            <div className="flex items-center justify-end gap-1 px-2 pt-1">
                              <button data-testid="button-sort-hand"
                                onClick={() => setHandSortMode(m => m === "suit" ? "rank" : "suit")}
                                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold border transition-all active:scale-95
                                  bg-white/5 border-white/15 text-white/40 hover:text-white/70 hover:bg-white/10">
                                <ArrowUpDown className="w-2.5 h-2.5" />
                                {handSortMode === "suit" ? "ترتيب بالرتبة" : "ترتيب بالبذرة"}
                              </button>
                            </div>
                            {topRow.length > 0 && (
                              <div className="relative flex-1 min-h-0">
                                {renderRow(topRow, botRow.length)}
                              </div>
                            )}
                            <div className="relative flex-1 min-h-0">
                              {renderRow(botRow, 0)}
                            </div>
                          </div>
                        );
                      })() : playingPhase ? (
                        <div className="h-full flex items-center justify-center text-gray-400 text-sm">
                          {trickNumber > 0 ? "انتهت كروتك" : ""}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}

                {/* ── Purchase phase bottom bar — compact single row ── */}
                {!playingPhase && myHand.length > 0 && (
                  <div className="flex-shrink-0" style={{
                    background: 'rgba(5,8,6,0.97)',
                    borderTop: '1px solid rgba(255,255,255,0.07)',
                    paddingBottom: 'max(8px, env(safe-area-inset-bottom, 8px))',
                    paddingTop: 8,
                    paddingLeft: 12,
                    paddingRight: 12,
                  }}>
                    {(() => {
                      const maxT = playerCount === 4 ? 13 : 9;
                      const mySubmitted = submittedPurchases[myIndex] !== null;
                      const isLocked = (forcedBuyPlayer !== null && myIndex !== forcedBuyPlayer) ||
                        (forcedBuyPlayer === null && forcedBuyTeam !== null && (isTeam1 ? 0 : 1) !== forcedBuyTeam);
                      const isForcedPlayer = forcedBuyPlayer === myIndex;
                      const minBidForMe = isForcedPlayer ? (playerCount === 4 ? 4 : 3) : (playerCount === 4 ? 2 : 1);
                      const isMyTurn = purchaseTurn === myIndex;
                      const teamColor = isTeam1
                        ? { btn: 'bg-red-600/80 hover:bg-red-500 active:bg-red-700 text-white border border-red-400/40', adj: 'bg-red-500/20 text-red-300 border border-red-500/40 hover:bg-red-500/35', num: 'border-red-500/50 text-red-100' }
                        : { btn: 'bg-sky-700/80 hover:bg-sky-600 active:bg-sky-800 text-white border border-sky-400/40', adj: 'bg-sky-500/20 text-sky-300 border border-sky-500/40 hover:bg-sky-500/35', num: 'border-sky-500/50 text-sky-100' };

                      // ── All submitted: slim countdown only ──
                      if (allSubmitted) {
                        return (
                          <div className="flex items-center justify-center gap-3 h-10">
                            <span className="text-green-400 text-xs font-bold">✓ اكتمل الشراء</span>
                            {purchaseCountdown !== null && (
                              <>
                                <span className="text-white/20 text-xs">·</span>
                                <span className="text-[11px] text-white/50">تبدأ اللعبة في</span>
                                <span className={`text-base font-black tabular-nums ${purchaseCountdown <= 2 ? "text-red-400 animate-pulse" : "text-yellow-300"}`}>
                                  {purchaseCountdown}ث
                                </span>
                              </>
                            )}
                          </div>
                        );
                      }

                      // ── Locked out ──
                      if (isLocked) return (
                        <div className="flex items-center gap-2 h-10">
                          <span className="text-xl">🔒</span>
                          <span className="text-xs text-orange-400/80">
                            {forcedBuyPlayer !== null ? `${players[forcedBuyPlayer]?.name ?? "اللاعب"} مُجبَر — شرائك صفر تلقائياً` : "فريقك لا يشتري هذه الجولة"}
                          </span>
                        </div>
                      );

                      // ── Submitted, waiting ──
                      if (mySubmitted) return (
                        <div className="flex items-center justify-between h-10">
                          <div className="flex items-center gap-1.5">
                            <span className="text-green-400 text-base">✓</span>
                            <span className="text-xs text-white/60">شرائك:</span>
                            <span className={`text-sm font-black ${isTeam1 ? "text-red-300" : "text-sky-300"}`}>
                              {(submittedPurchases[myIndex] ?? 0) >= maxT ? "لورنس ⚡" : submittedPurchases[myIndex]}
                            </span>
                          </div>
                          <span className="text-[10px] text-white/30">{submittedCount}/{playerCount} أكملوا</span>
                        </div>
                      );

                      // ── Waiting for another player (not my turn) ──
                      if (!isMyTurn) return (
                        <div className="flex items-center gap-2 h-10">
                          <span className="text-base animate-pulse">⏳</span>
                          <span className="text-xs text-white/50">
                            {purchaseTurn !== -1 ? `بانتظار ${players[purchaseTurn]?.name ?? ""}…` : `${submittedCount}/${playerCount} أكملوا`}
                          </span>
                          {purchaseTimer !== null && purchaseTurn !== -1 && (
                            <span className={`text-sm font-black tabular-nums mr-auto ${purchaseTimer <= 5 ? "text-red-400 animate-pulse" : purchaseTimer <= 10 ? "text-yellow-400" : "text-white/40"}`}>
                              {purchaseTimer}ث
                            </span>
                          )}
                        </div>
                      );

                      // ── My turn: single compact row ──
                      return (
                        <div className="flex items-center gap-2">
                          {/* Timer circle — small */}
                          {purchaseTimer !== null ? (
                            <div className="relative flex-shrink-0 flex items-center justify-center w-9 h-9">
                              <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 36 36">
                                <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" />
                                <circle cx="18" cy="18" r="14" fill="none"
                                  stroke={purchaseTimer <= 5 ? "#ef4444" : purchaseTimer <= 10 ? "#f59e0b" : "#22c55e"}
                                  strokeWidth="3" strokeLinecap="round"
                                  strokeDasharray={`${2 * Math.PI * 14}`}
                                  strokeDashoffset={`${2 * Math.PI * 14 * (1 - purchaseTimer / 20)}`}
                                  style={{ transition: "stroke-dashoffset 1s linear, stroke 0.3s" }} />
                              </svg>
                              <span className={`absolute text-[11px] font-black tabular-nums ${purchaseTimer <= 5 ? "text-red-400" : purchaseTimer <= 10 ? "text-yellow-400" : "text-green-400"}`}>
                                {purchaseTimer}
                              </span>
                            </div>
                          ) : (
                            <span className="text-yellow-400 text-[11px] font-bold animate-pulse flex-shrink-0">🎯 دورك</span>
                          )}
                          {isForcedPlayer && (
                            <span className="text-[9px] bg-yellow-500/20 text-yellow-300 border border-yellow-500/40 rounded-full px-1.5 py-0.5 font-semibold flex-shrink-0">⚡≥{minBidForMe}</span>
                          )}
                          {/* − button */}
                          <button data-testid="button-purchase-minus-unified"
                            onClick={() => setMyDraft(v => Math.max(minBidForMe, v - 1))}
                            disabled={cardsJustDealt}
                            className={`w-10 h-10 rounded-xl font-black text-xl flex items-center justify-center active:scale-90 transition-transform disabled:opacity-30 ${teamColor.adj}`}>
                            −
                          </button>
                          {/* Bid display */}
                          <div className={`flex-1 h-10 rounded-xl border-2 flex items-center justify-center font-black text-lg ${teamColor.num}`}
                            style={{ background: 'rgba(0,0,0,0.5)' }}>
                            {myDraft >= maxT ? <span className="text-yellow-300 text-sm font-black">لورنس ⚡</span> : myDraft}
                          </div>
                          {/* + button */}
                          <button data-testid="button-purchase-plus-unified"
                            onClick={() => setMyDraft(v => Math.min(maxT, v + 1))}
                            disabled={cardsJustDealt}
                            className={`w-10 h-10 rounded-xl font-black text-xl flex items-center justify-center active:scale-90 transition-transform disabled:opacity-30 ${teamColor.adj}`}>
                            +
                          </button>
                          {/* Submit */}
                          <button data-testid="button-submit-purchase-unified"
                            onClick={handleSubmitPurchase}
                            disabled={cardsJustDealt}
                            className={`h-10 px-4 rounded-xl text-sm font-bold active:scale-95 transition-transform disabled:opacity-30 flex-shrink-0 ${teamColor.btn}`}>
                            أرسل
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* ── Bottom bar: avatar + playing-phase status ── */}
                {playingPhase && (
                  <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-black/70 border-t border-white/5"
                    style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom, 8px))' }}>
                    {/* My avatar */}
                    <div className={`relative w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center font-bold text-sm border-2
                      ${trickWinnerBanner === myIndex ? "border-yellow-300 shadow-yellow-400/70 trick-winner-flash" : isTeam1 ? "border-red-400" : "border-zinc-400"}
                      ${isTeam1 ? "bg-red-900 text-red-100" : "bg-zinc-800 text-zinc-100"}`}>
                      {players[myIndex]?.name?.slice(0, 2) ?? "أنا"}
                      {trickWinnerBanner === myIndex && <span className="absolute inset-0 rounded-full border-2 border-yellow-300 animate-ping opacity-70" />}
                    </div>
                    <div className="flex flex-col leading-tight flex-shrink-0">
                      <span className="text-xs font-semibold text-white/80">{players[myIndex]?.name ?? "أنت"}</span>
                      <span className={`text-[9px] ${isTeam1 ? "text-red-400" : "text-zinc-400"}`}>
                        {isTeam1 ? "العربي" : "السد"} · ★{tricksWon[myIndex] ?? 0}
                      </span>
                    </div>

                    <>
                        {/* Play timer — visible to all players */}
                        {!trickAnimating && playTimer !== null && (
                          <div className={`relative flex items-center justify-center w-9 h-9 rounded-full border-2 font-extrabold text-xs flex-shrink-0
                            ${playTimer <= 5 ? "border-red-400 text-red-300 animate-pulse" : playTimer <= 10 ? "border-yellow-400 text-yellow-300" : "border-green-400 text-green-300"}
                            bg-black/60`}>
                            {playTimer}
                            <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 36 36">
                              <circle cx="18" cy="18" r="15" fill="none" strokeWidth="2.5" className={playTimer <= 5 ? "stroke-red-400/30" : playTimer <= 10 ? "stroke-yellow-400/30" : "stroke-green-400/30"} />
                              <circle cx="18" cy="18" r="15" fill="none" strokeWidth="2.5"
                                strokeDasharray={`${2 * Math.PI * 15}`}
                                strokeDashoffset={`${2 * Math.PI * 15 * (1 - playTimer / 20)}`}
                                strokeLinecap="round"
                                className={`transition-all duration-1000 ${playTimer <= 5 ? "stroke-red-400" : playTimer <= 10 ? "stroke-yellow-400" : "stroke-green-400"}`} />
                            </svg>
                          </div>
                        )}
                        {/* Sort button */}
                        {!isSpectatorRef.current && (
                          <button data-testid="button-sort-cards"
                            onClick={toggleSort}
                            title="ترتيب الكروت"
                            className={`w-7 h-7 rounded-full flex items-center justify-center transition-all active:scale-90 flex-shrink-0
                              ${isSorted ? "bg-primary/20 text-primary border border-primary/40" : "bg-white/5 text-white/40 hover:bg-white/15"}`}>
                            <ArrowUpDown className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {/* Hint button */}
                        {!isSpectatorRef.current && currentTurn === myIndex && !trickAnimating && hintCard && (
                          <button data-testid="button-hint"
                            onClick={() => setShowHint(v => !v)}
                            title="تلميح"
                            className={`w-7 h-7 rounded-full flex items-center justify-center transition-all active:scale-90 flex-shrink-0
                              ${showHint ? "bg-yellow-400/25 text-yellow-300 border border-yellow-400/50 animate-pulse" : "bg-white/5 text-white/40 hover:bg-white/15"}`}>
                            <Lightbulb className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <div className="flex-1" />
                        {/* Quick emoji reaction buttons */}
                        {!isSpectatorRef.current && (
                          <div className="flex gap-0.5 flex-shrink-0">
                            {["👍","🔥","😬","😄","👏"].map((emoji) => (
                              <button key={emoji} data-testid={`button-emoji-${emoji}`}
                                onClick={() => sendEmoji(emoji)}
                                className="w-7 h-7 rounded-full bg-white/5 hover:bg-white/15 active:scale-90 transition-all flex items-center justify-center text-base leading-none">
                                {emoji}
                              </button>
                            ))}
                          </div>
                        )}
                        {currentTurn === myIndex && !trickAnimating && (
                          <span className="text-yellow-400 text-xs font-bold animate-pulse flex-shrink-0">← دورك</span>
                        )}
                        <div className="text-xs text-white/40 flex-shrink-0">{t1Won + t2Won}/{totalTricks} طلعة</div>
                    </>
                  </div>
                )}

              </div>
            );
          })()}

          {/* Round Log */}
          {roundLog.length > 0 && !playingPhase && myHand.length === 0 && (
            <Card className="border-border/40">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm text-muted-foreground">سجل الجولات</CardTitle>
                  {roundDuration !== null && (
                    <div className="flex items-center gap-1 text-[10px] text-amber-400/70 font-medium">
                      <Timer className="w-3 h-3" />
                      {roundDuration >= 60
                        ? `${Math.floor(roundDuration / 60)}د ${roundDuration % 60}ث`
                        : `${roundDuration}ث`}
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-1.5 max-h-48 overflow-y-auto">
                {[...roundLog].reverse().map((log, i) => (
                  <div key={i} className="text-xs text-muted-foreground bg-muted/30 rounded px-2.5 py-1.5 border border-border/20">{log}</div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Chat */}
        {chatOpen && (
          <div className="fixed sm:relative inset-x-0 bottom-0 sm:inset-auto z-50 sm:z-auto w-full sm:w-72 h-[60vh] sm:h-full border-t sm:border-t-0 border-r border-border/40 bg-card/95 sm:bg-card/60 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
              <span className="text-sm font-semibold flex items-center gap-1.5"><MessageCircle className="w-4 h-4 text-primary" />الشات</span>
              <div className="flex items-center gap-1.5">
                {/* Sound + mic — always visible in chat header */}
                <button data-testid="chat-toggle-sound"
                  onClick={() => setSoundEnabled(v => !v)}
                  className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all ${soundEnabled ? "bg-white/10 text-white/80 border border-white/20" : "bg-white/4 text-white/25"}`}
                  title={soundEnabled ? "إيقاف الصوت" : "تشغيل الصوت"}>
                  {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
                </button>
                <button data-testid="chat-toggle-mic"
                  onClick={toggleMic}
                  className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all ${micOn ? "bg-primary/25 text-primary border border-primary/40" : "bg-white/4 text-white/25"}`}
                  title={micOn ? "إيقاف المايك" : "تشغيل المايك"}>
                  {micOn ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
                </button>
                <Button size="icon" variant="ghost" onClick={() => setChatOpen(false)} className="h-6 w-6"><X className="w-3.5 h-3.5" /></Button>
              </div>
            </div>
            {/* Spectators list */}
            {spectators.length > 0 && (
              <div className="px-3 py-2 border-b border-border/30 bg-muted/10">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-semibold mb-1.5">
                  <Eye className="w-3 h-3" />مشاهدون ({spectators.length})
                </div>
                <div className="flex flex-wrap gap-1">
                  {spectators.map((s) => (
                    <span key={s.socketId} className="text-[10px] px-2 py-0.5 rounded-full bg-muted/30 border border-border/30 text-muted-foreground">
                      {s.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {chatMessages.length === 0 && <div className="text-center text-muted-foreground text-xs py-4">لا توجد رسائل بعد</div>}
              {chatMessages.map((m, i) => (
                <div key={i} className="text-right">
                  <div className="text-xs text-muted-foreground mb-0.5">{m.sender} · {m.time}</div>
                  <div className="inline-block bg-muted/50 rounded-md px-2.5 py-1.5 text-sm max-w-full">{m.text}</div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="p-2 border-t border-border/30 flex gap-2">
              <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendChat()} placeholder="اكتب رسالة..." dir="rtl" data-testid="input-chat" className="flex-1 h-8 rounded-md border border-border/50 bg-background/50 px-2 text-base md:text-sm focus:outline-none focus:border-primary/50" />
              <Button size="icon" className="h-8 w-8" onClick={sendChat} data-testid="button-send-chat"><Send className="w-3.5 h-3.5" /></Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Settings Panel (slide-up from bottom) ─────────────── */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={() => setShowSettings(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-sm rounded-t-2xl border border-white/10 shadow-2xl overflow-y-auto"
            style={{ background: 'linear-gradient(180deg,#1a1a2e 0%,#0f0f1a 100%)', maxHeight: '85vh', paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}
            onClick={(e) => e.stopPropagation()}>
            <div className="p-5 space-y-4">
            {/* Handle bar */}
            <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mb-1" />
            <h2 className="text-sm font-bold text-white/90 text-center flex items-center justify-center gap-2">
              <Settings className="w-4 h-4 text-primary" /> الإعدادات
            </h2>

            {/* Mic row */}
            <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
              <div className="flex items-center gap-2.5">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${micOn ? "bg-primary/20 text-primary" : "bg-white/5 text-white/30"}`}>
                  {micOn ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                </div>
                <div>
                  <div className="text-sm font-semibold text-white/90">الميكروفون</div>
                  <div className="text-[10px] text-white/40">دردشة صوتية مع اللاعبين</div>
                </div>
              </div>
              <button data-testid="setting-mic"
                onClick={toggleMic}
                className={`relative w-12 h-6 rounded-full transition-all duration-300 flex-shrink-0 ${micOn ? "bg-primary" : "bg-white/10"}`}>
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all duration-300 ${micOn ? "right-1" : "left-1"}`} />
              </button>
            </div>

            {/* Settings rows */}
            {([
              {
                icon: <Volume2 className="w-4 h-4" />, label: "الصوت",
                desc: "أصوات اللعبة والتنبيهات",
                value: soundEnabled, toggle: () => setSoundEnabled(v => !v), testId: "setting-sound",
              },
              {
                icon: <Vibrate className="w-4 h-4" />, label: "الاهتزاز",
                desc: "اهتزاز عند حلول دورك",
                value: vibrationEnabled, toggle: () => setVibrationEnabled(v => !v), testId: "setting-vibration",
              },
              {
                icon: <Lightbulb className="w-4 h-4" />, label: "تلميح تلقائي",
                desc: "يظهر التلميح عند دورك",
                value: autoHint, toggle: () => setAutoHint(v => !v), testId: "setting-autohint",
              },
            ] as const).map((s) => (
              <div key={s.testId} className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
                <div className="flex items-center gap-2.5">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${s.value ? "bg-primary/20 text-primary" : "bg-white/5 text-white/30"}`}>
                    {s.icon}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-white/90">{s.label}</div>
                    <div className="text-[10px] text-white/40">{s.desc}</div>
                  </div>
                </div>
                <button data-testid={s.testId}
                  onClick={s.toggle}
                  className={`relative w-12 h-6 rounded-full transition-all duration-300 flex-shrink-0 ${s.value ? "bg-primary" : "bg-white/10"}`}>
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all duration-300 ${s.value ? "right-1" : "left-1"}`} />
                </button>
              </div>
            ))}

            {/* Color blind mode */}
            <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
              <div className="flex items-center gap-2.5">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${colorBlindMode ? "bg-blue-500/20 text-blue-400" : "bg-white/5 text-white/30"}`}><span className="text-sm">♦</span></div>
                <div>
                  <div className="text-sm font-semibold text-white/90">وضع عمى الألوان</div>
                  <div className="text-[10px] text-white/40">تمييز ♦ بلون أزرق عن ♥</div>
                </div>
              </div>
              <button data-testid="setting-colorblind" onClick={() => setColorBlindMode(v => !v)}
                className={`relative w-12 h-6 rounded-full transition-all duration-300 flex-shrink-0 ${colorBlindMode ? "bg-blue-500" : "bg-white/10"}`}>
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all duration-300 ${colorBlindMode ? "right-1" : "left-1"}`} />
              </button>
            </div>
            {/* Animation speed */}
            <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/5 text-white/30"><Timer className="w-4 h-4" /></div>
                <div>
                  <div className="text-sm font-semibold text-white/90">سرعة الحركة</div>
                  <div className="text-[10px] text-white/40">سرعة أنيميشن الكروت</div>
                </div>
              </div>
              <div className="flex gap-1">
                {(["fast","normal","slow"] as const).map((s) => (
                  <button key={s} data-testid={`setting-animspeed-${s}`} onClick={() => setAnimSpeed(s)}
                    className={`px-2 py-1 rounded-md text-[10px] font-bold border transition-all ${animSpeed === s ? "border-primary/60 bg-primary/20 text-primary" : "border-white/10 text-white/30"}`}>
                    {s === "fast" ? "سريع" : s === "normal" ? "عادي" : "بطيء"}
                  </button>
                ))}
              </div>
            </div>

            {/* Card size */}
            <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/5 text-white/30">
                  <CreditCard className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-white/90">حجم الكروت</div>
                  <div className="text-[10px] text-white/40">حجم الكروت في يدك</div>
                </div>
              </div>
              <div className="flex gap-1">
                {(["sm", "md", "lg"] as const).map((s) => (
                  <button key={s} data-testid={`setting-cardsize-${s}`}
                    onClick={() => setCardSizePref(s)}
                    className={`px-2 py-1 rounded-md text-[10px] font-bold border transition-all ${cardSizePref === s ? "border-primary/60 bg-primary/20 text-primary" : "border-white/10 text-white/30"}`}>
                    {s === "sm" ? "صغير" : s === "md" ? "متوسط" : "كبير"}
                  </button>
                ))}
              </div>
            </div>

            {/* Table theme */}
            <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/5 text-white/30">
                  <Palette className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-white/90">لون الطاولة</div>
                  <div className="text-[10px] text-white/40">اختر لون البساط</div>
                </div>
              </div>
              <div className="flex gap-1.5">
                {([
                  { id: "green",  bg: "bg-emerald-700",  ring: "ring-emerald-400" },
                  { id: "blue",   bg: "bg-sky-700",      ring: "ring-sky-400" },
                  { id: "purple", bg: "bg-purple-700",   ring: "ring-purple-400" },
                  { id: "brown",  bg: "bg-amber-900",    ring: "ring-amber-600" },
                ] as { id: "green"|"blue"|"purple"|"brown"; bg: string; ring: string }[]).map((t) => (
                  <button key={t.id} data-testid={`setting-theme-table-${t.id}`}
                    onClick={() => setTableTheme(t.id)}
                    className={`w-6 h-6 rounded-full ${t.bg} transition-all ${tableTheme === t.id ? `ring-2 ring-offset-1 ring-offset-zinc-900 ${t.ring} scale-110` : "opacity-50 hover:opacity-80"}`} />
                ))}
              </div>
            </div>

            {/* Table shape (4-player only) */}
            {playerCount !== 6 && (
              <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/5 text-white/30">
                    <Hexagon className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-white/90">شكل الطاولة</div>
                    <div className="text-[10px] text-white/40">مستطيل أو بيضاوي</div>
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <button data-testid="setting-tableshape-rect" onClick={() => setTableShape("rect")}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-bold border transition-all ${tableShape === 'rect' ? 'border-rose-400/60 bg-rose-500/15 text-rose-300' : 'border-white/10 text-white/30 hover:border-white/25'}`}>
                    مستطيل
                  </button>
                  <button data-testid="setting-tableshape-oval" onClick={() => setTableShape("oval")}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-bold border transition-all ${tableShape === 'oval' ? 'border-rose-400/60 bg-rose-500/15 text-rose-300' : 'border-white/10 text-white/30 hover:border-white/25'}`}>
                    بيضاوي
                  </button>
                </div>
              </div>
            )}

            {/* Share room */}
            {phase === "game" && (
              <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/6">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/5 text-white/30">
                    <Share2 className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-white/90">مشاركة الغرفة</div>
                    <div className="text-[10px] text-white/40 truncate max-w-[120px]">كود: {roomId}</div>
                  </div>
                </div>
                <Button size="sm" variant="outline" data-testid="setting-share-room"
                  onClick={handleShareRoom}
                  className={`text-xs h-7 px-3 transition-all ${shareCopied ? "border-green-400/60 text-green-400 bg-green-400/10" : ""}`}>
                  {shareCopied ? "✓ تم النسخ" : "نسخ الرابط"}
                </Button>
              </div>
            )}

            {/* Fullscreen */}
            <div className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/5 text-white/30">
                  {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                </div>
                <div>
                  <div className="text-sm font-semibold text-white/90">ملء الشاشة</div>
                  <div className="text-[10px] text-white/40">يخفي شريط المتصفح</div>
                </div>
              </div>
              <Button size="sm" variant="outline" className="text-xs h-7 px-3" onClick={toggleFullscreen} data-testid="setting-fullscreen">
                {isFullscreen ? "خروج" : "تفعيل"}
              </Button>
            </div>

            {/* Theme toggle */}
            <div className="flex items-center justify-between gap-3 py-2.5 border-t border-white/6 mt-1 pt-3">
              <div className="flex items-center gap-2.5">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${theme === "light" ? "bg-amber-400/20 text-amber-400" : "bg-indigo-500/20 text-indigo-300"}`}>
                  {theme === "light" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                </div>
                <div>
                  <div className="text-sm font-semibold text-white/90">مظهر التطبيق</div>
                  <div className="text-[10px] text-white/40">{theme === "light" ? "وضع النهار" : "وضع الليل"}</div>
                </div>
              </div>
              <div className="flex gap-1">
                <button data-testid="setting-theme-dark"
                  onClick={() => setTheme("dark")}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-bold border transition-all flex items-center gap-1
                    ${theme === "dark" ? "border-indigo-400/60 bg-indigo-500/20 text-indigo-300" : "border-white/10 text-white/30"}`}>
                  <Moon className="w-3 h-3" /> داكن
                </button>
                <button data-testid="setting-theme-light"
                  onClick={() => setTheme("light")}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-bold border transition-all flex items-center gap-1
                    ${theme === "light" ? "border-amber-400/60 bg-amber-400/20 text-amber-400" : "border-white/10 text-white/30"}`}>
                  <Sun className="w-3 h-3" /> فاتح
                </button>
              </div>
            </div>

            {/* Reset game */}
            <div className="flex items-center justify-between gap-3 py-2.5 border-t border-white/6 mt-1 pt-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/5 text-white/30">
                  <RotateCcw className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-white/90">إعادة اللعبة</div>
                  <div className="text-[10px] text-white/40">ابدأ جولة جديدة</div>
                </div>
              </div>
              <Button size="sm" variant="outline" className="text-xs h-7 px-3" onClick={() => { handleReset(); setShowSettings(false); }} data-testid="setting-reset">
                إعادة
              </Button>
            </div>

            {/* Connection info */}
            <div className="flex items-center gap-2 py-2 text-[10px] text-white/30">
              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? "bg-green-400" : "bg-red-400"}`} />
              <span>{connected ? `متصل · ${onlinePlayers} لاعب أونلاين` : "غير متصل"}</span>
              {spectators.length > 0 && <span className="mr-auto text-muted-foreground/60">{spectators.length} مشاهد</span>}
            </div>

            <button onClick={() => setShowSettings(false)} className="w-full py-2 text-xs text-white/40 hover:text-white/70 transition-colors">
              إغلاق
            </button>
            </div>{/* end p-5 space-y-4 */}
          </div>
        </div>
      )}

      {/* ── Sweep (كشخة) celebration banner ──────────────────────── */}
      {sweepBannerTeam !== null && (
        <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center">
          <div className={`slide-up flex flex-col items-center gap-2 px-6 py-4 rounded-2xl shadow-2xl border-2 text-center
            ${sweepBannerTeam === 0
              ? "bg-red-900/95 border-red-400/80 shadow-red-900/60"
              : "bg-zinc-800/95 border-zinc-400/80 shadow-zinc-900/60"}`}>
            <span className="text-4xl leading-none">♛</span>
            <div className="text-lg font-extrabold text-white/95">
              {sweepBannerTeam === 0 ? "العربي" : "السد"} سحل الكل!
            </div>
            <div className={`text-sm font-semibold ${sweepBannerTeam === 0 ? "text-red-300" : "text-zinc-300"}`}>
              فوز بجميع الطلعات +2 نقطة إضافية 🎉
            </div>
          </div>
        </div>
      )}

      {/* ── Failed bid banner ─────────────────────────────────────── */}
      {failBidBanner && (
        <div className="fixed left-1/2 -translate-x-1/2 z-50 pointer-events-none"
          style={{ top: 'calc(64px + env(safe-area-inset-top, 0px))' }}>
          <div className="slide-up flex flex-col items-center gap-1 px-5 py-3 rounded-xl shadow-2xl border bg-zinc-900/95 border-orange-500/60 shadow-orange-900/40 text-center">
            <div className="text-sm font-extrabold text-orange-300">
              💀 {failBidBanner.teamLabel} خسر الشراء!
            </div>
            <div className="text-xs text-white/60">
              شرى {failBidBanner.bid} · أخذ {failBidBanner.got} · يُخصم{" "}
              <span className="text-orange-400 font-bold">-{failBidBanner.penalty}</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Trick winner banner ────────────────────────────────── */}
      {/* trickWinnerBanner: now flashes the avatar directly — no banner needed */}

      {/* ── My-turn bid summary banner ─────────────────────────── */}


      {/* ── Emoji reactions floating overlay ──────────────────── */}
      {emojiReactions.map((r) => (
        <div key={r.id} className="fixed z-50 pointer-events-none"
          style={{ bottom: 'calc(200px + env(safe-area-inset-bottom, 0px))', left: `${r.x}%`, animation: "floatEmoji 2.5s ease-out forwards" }}>
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-3xl leading-none">{r.emoji}</span>
            <span className="text-[9px] text-white/70 font-bold bg-black/50 px-1 rounded">{r.name}</span>
          </div>
        </div>
      ))}


      {/* ── Lawrence police-siren alert ─────────────────────────── */}
      {lawrenceAlert && (
        <div className="fixed inset-0 pointer-events-none siren-border-anim siren-bg-anim" style={{ zIndex: 9500 }}>
          {/* left red sweep */}
          <div className="absolute inset-y-0 left-0 w-1/3 siren-light-left" />
          {/* right blue sweep */}
          <div className="absolute inset-y-0 right-0 w-1/3 siren-light-right" />
          {/* center content */}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4">
            <div className="flex items-center gap-3">
              <span className="text-4xl select-none">🚨</span>
              <span className="text-4xl select-none">🚨</span>
            </div>
            <div className="siren-text text-3xl font-black tracking-widest text-center" style={{ fontFamily: 'inherit' }}>
              لورنس!
            </div>
            <div className="bg-black/60 rounded-2xl px-5 py-3 flex flex-col items-center gap-1 border border-white/10"
              style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
              <span className="text-white/70 text-sm font-medium">
                {lawrenceAlert.team === 0 ? "فريق العربي" : "فريق السد"}
              </span>
              <span className="text-white font-bold text-base">
                {lawrenceAlert.playerName}
              </span>
              <span className="text-white/60 text-xs text-center mt-1">
                اشترى جميع الأوراق! الفوز بكل ورقة أو الخسارة
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-4xl select-none">🚨</span>
              <span className="text-4xl select-none">🚨</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Celebration overlay: fireworks + winner banner ──────── */}
      {showCelebration && winner && (
        <>
          <CelebrationCanvas winner={winner} />
          <div className="fixed inset-0 flex flex-col items-center justify-center pointer-events-none"
            style={{ zIndex: 10000 }}>
            {/* Trophy burst ring */}
            <div className="relative flex items-center justify-center mb-4">
              <div className={`absolute w-44 h-44 rounded-full opacity-20 animate-ping
                ${winner === "العربي" ? "bg-red-400" : "bg-sky-400"}`} />
              <div className={`absolute w-32 h-32 rounded-full opacity-30
                ${winner === "العربي" ? "bg-red-500" : "bg-sky-500"}`} />
              <span className="text-7xl relative z-10 drop-shadow-2xl">🏆</span>
            </div>
            {/* Winner label */}
            <div className="slide-up text-center px-8 py-5 rounded-3xl border-2 shadow-2xl mx-4"
              style={{
                background: winner === "العربي"
                  ? 'linear-gradient(135deg, rgba(127,29,29,0.97) 0%, rgba(185,28,28,0.95) 100%)'
                  : 'linear-gradient(135deg, rgba(12,74,110,0.97) 0%, rgba(2,132,199,0.95) 100%)',
                borderColor: winner === "العربي" ? '#f87171' : '#38bdf8',
                boxShadow: winner === "العربي"
                  ? '0 0 60px rgba(239,68,68,0.5), 0 24px 64px rgba(0,0,0,0.7)'
                  : '0 0 60px rgba(56,189,248,0.5), 0 24px 64px rgba(0,0,0,0.7)',
              }}>
              <div className="text-white/60 text-sm font-semibold uppercase tracking-widest mb-1">اللعبة انتهت</div>
              <div className="text-4xl font-black text-white mb-1">{winner}</div>
              <div className="text-white/80 text-lg font-bold">فاز! 🎉</div>
              <div className="flex items-center justify-center gap-3 mt-3 text-sm font-bold">
                <span className="text-red-200 bg-red-900/50 px-3 py-1 rounded-full">العربي {team1Score}</span>
                <span className="text-white/30">–</span>
                <span className="text-sky-200 bg-sky-900/50 px-3 py-1 rounded-full">السد {team2Score}</span>
              </div>
            </div>
            <div className="mt-5 text-white/50 text-xs animate-pulse">
              {["✨","🎊","🎆","🎇","🥳"].map((e, i) => (
                <span key={i} className="mx-1">{e}</span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
