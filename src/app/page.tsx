"use client";
import React, { useState, useEffect, useRef } from 'react';
import { Trophy, Users, MessageCircle, Send, Mic, MicOff, Settings, Play, LogOut } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { io } from "socket.io-client";

// استبدل هذا الرابط برابط السيرفر الخاص بك من موقع Render
const socket = io("https://sbiat-server.onrender.com");

type CardStr = string;

export default function SbiatGame() {
  const [gameState, setGameState] = useState<"lobby" | "playing" | "finished">("lobby");
  const [myCards, setMyCards] = useState<CardStr[]>([]);
  const [tableCards, setTableCards] = useState<{player: string, card: CardStr}[]>([]);
  const [scores, setScores] = useState({ العربي: 0, السد: 0 });
  const [messages, setMessages] = useState<{id: string, sender: string, text: string}[]>([]);
  const [inputMsg, setInputMsg] = useState("");
  const [isMicActive, setIsMicActive] = useState(false);
  const [winner, setWinner] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const arabiLogo = "https://upload.wikimedia.org/wikipedia/en/thumb/4/4b/Al-Arabi_SC_logo.svg/1200px-Al-Arabi_SC_logo.svg.png";
  const saddLogo = "https://upload.wikimedia.org/wikipedia/en/thumb/0/01/Al_Sadd_SC_Logo.svg/1200px-Al_Sadd_SC_Logo.svg.png";

  useEffect(() => {
    socket.on("receive_hand", (cards: CardStr[]) => {
      setMyCards(cards);
      setGameState("playing");
    });

    socket.on("new_message", (msg) => {
      setMessages(prev => [...prev, msg]);
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });

    return () => { socket.off(); };
  }, []);

  const renderCard = (card: CardStr, index: number, isPlayable: boolean = true) => {
    const isRed = card.includes('♥') || card.includes('♦');
    return (
      <div
        key={index}
        onClick={() => isPlayable && socket.emit("play_card", card)}
        className={`relative w-16 h-24 md:w-20 md:h-28 bg-white rounded-xl shadow-2xl flex flex-col items-center justify-between p-2 cursor-pointer transform transition-all duration-300 hover:-translate-y-8 hover:rotate-2 border-2 ${
          isPlayable ? 'hover:border-yellow-400 border-transparent' : 'border-gray-200'
        }`}
      >
        <div className={`self-start text-sm font-bold ${isRed ? 'text-red-600' : 'text-black'}`}>{card}</div>
        <div className={`text-2xl md:text-3xl ${isRed ? 'text-red-600' : 'text-black'}`}>{card.slice(-1)}</div>
        <div className={`self-end text-sm font-bold rotate-180 ${isRed ? 'text-red-600' : 'text-black'}`}>{card}</div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white font-sans selection:bg-yellow-500/30 overflow-hidden" dir="rtl">
      <header className="fixed top-0 left-0 right-0 z-50 p-4 bg-black/40 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3">
            <img src={arabiLogo} className="w-10 h-10 rounded-full" />
            <div className="text-2xl font-black italic tracking-tighter text-white/90 text-center">SBIAT <span className="text-yellow-500">PRO</span></div>
            <img src={saddLogo} className="w-10 h-10 rounded-full" />
          </div>
          <div className="flex gap-4 bg-white/5 px-6 py-2 rounded-2xl border border-white/10">
            <div className="text-center"><p className="text-[10px] text-red-400">العربي</p><p className="text-xl font-black">{scores.العربي}</p></div>
            <div className="h-8 w-[1px] bg-white/10 mx-2" />
            <div className="text-center"><p className="text-[10px] text-blue-400">السد</p><p className="text-xl font-black">{scores.السد}</p></div>
          </div>
          <Button variant="ghost" className="rounded-full w-10 h-10 p-0 text-white/50"><Settings className="w-5 h-5" /></Button>
        </div>
      </header>

      <main className="relative h-screen flex flex-col items-center justify-center pt-20">
        {gameState === "lobby" ? (
          <div className="text-center space-y-8 animate-in fade-in zoom-in duration-700">
             <Trophy className="w-24 h-24 text-yellow-500 mx-auto" />
             <h1 className="text-5xl font-black tracking-tight">جاهز للعب؟</h1>
             <Button onClick={() => socket.emit("start_game")} className="bg-white text-black hover:bg-yellow-500 font-black px-16 py-8 text-2xl rounded-full">
                <Play className="ml-3 w-6 h-6 fill-current" /> ابدأ الجولة
             </Button>
          </div>
        ) : (
          <div className="w-full h-full relative flex items-center justify-center">
            <div className="absolute w-[300px] h-[300px] md:w-[450px] md:h-[450px] border border-white/10 rounded-full bg-gradient-to-b from-white/5 to-transparent flex items-center justify-center">
               <div className="flex gap-4">
                  {tableCards.map((tc, i) => <div key={i}>{renderCard(tc.card, i, false)}</div>)}
               </div>
            </div>
          </div>
        )}
      </main>

      <footer className="fixed bottom-0 left-0 right-0 p-6 z-50">
        <div className="max-w-5xl mx-auto">
          {gameState === "playing" && (
            <div className="flex justify-center -space-x-4 mb-8 h-32 items-end">
              {myCards.map((card, i) => renderCard(card, i, true))}
            </div>
          )}
          <div className="flex justify-between items-end gap-4">
            <div className="w-80 bg-black/60 backdrop-blur-2xl rounded-2xl border border-white/10 flex flex-col h-64 overflow-hidden">
              <div className="p-3 border-b border-white/5 bg-white/5 flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-yellow-500" />
                <span className="text-xs font-bold uppercase">دردشة المجلس</span>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.map((msg) => (
                  <div key={msg.id}><span className="text-[10px] font-black text-yellow-500 ml-2">{msg.sender}:</span><span className="text-sm text-white/80">{msg.text}</span></div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <div className="p-2 bg-white/5 flex gap-2">
                <Input value={inputMsg} onChange={(e) => setInputMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && socket.emit("send_message", inputMsg)} placeholder="اكتب رسالتك..." className="bg-black/40 border-white/10 text-xs" />
                <Button size="icon" className="shrink-0 bg-yellow-500 text-black" onClick={() => { socket.emit("send_message", inputMsg); setInputMsg(""); }}>
                  <Send className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <Button onClick={() => setIsMicActive(!isMicActive)} className={`w-14 h-14 rounded-full ${isMicActive ? 'bg-red-600' : 'bg-white/10'}`}>
                {isMicActive ? <Mic className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
              </Button>
              <Button onClick={() => window.location.reload()} className="w-14 h-14 rounded-full bg-red-900/20 text-red-500 border border-red-500/20">
                <LogOut className="w-6 h-6" />
              </Button>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
