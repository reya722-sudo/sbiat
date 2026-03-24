"use client";
import React, { useState } from 'react';

export default function GamePage() {
  const [room, setRoom] = useState("");

  return (
    <div className="min-h-screen bg-slate-900 text-white flex flex-col items-center justify-center p-4">
      <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl border border-slate-700 w-full max-screen-sm text-center">
        <h1 className="text-4xl font-bold mb-6 text-yellow-500">لعبة السبيطة</h1>
        
        <div className="space-y-4">
          <input 
            type="text" 
            placeholder="أدخل رقم الغرفة"
            className="w-full p-3 rounded-lg bg-slate-700 border border-slate-600 text-white text-center focus:outline-none focus:ring-2 focus:ring-yellow-500"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
          />
          
          <button 
            className="w-full bg-yellow-600 hover:bg-yellow-500 text-white font-bold py-3 rounded-lg transition-all shadow-lg active:scale-95"
            onClick={() => alert(`جاري الدخول للغرفة: ${room}`)}
          >
            دخول الغرفة
          </button>
          
          <button 
            className="w-full bg-slate-600 hover:bg-slate-500 text-white font-bold py-3 rounded-lg transition-all shadow-lg active:scale-95"
          >
            إنشاء غرفة جديدة
          </button>
        </div>
      </div>
    </div>
  );
}
