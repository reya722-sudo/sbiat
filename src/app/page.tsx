"use client";
import React, { useState } from 'react';

export default function GamePage() {
  const [room, setRoom] = useState("");

  return (
    <div style={{ 
      minHeight: '100vh', 
      backgroundColor: '#0f172a', 
      color: 'white', 
      display: 'flex', 
      flexDirection: 'column', 
      alignItems: 'center', 
      justifyContent: 'center', 
      fontFamily: 'sans-serif',
      direction: 'rtl' 
    }}>
      <div style={{ 
        backgroundColor: '#1e293b', 
        padding: '2rem', 
        borderRadius: '1rem', 
        textAlign: 'center', 
        boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
        width: '90%',
        maxWidth: '400px'
      }}>
        <h1 style={{ color: '#eab308', fontSize: '2.5rem', marginBottom: '1.5rem' }}>لعبة السبيطة</h1>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <input 
            type="text" 
            placeholder="أدخل رقم الغرفة"
            style={{ 
              width: '100%', 
              padding: '12px', 
              borderRadius: '8px', 
              border: '1px solid #475569', 
              backgroundColor: '#334155', 
              color: 'white', 
              textAlign: 'center' 
            }}
            value={room}
            onChange={(e) => setRoom(e.target.value)}
          />
          
          <button 
            style={{ 
              width: '100%', 
              padding: '12px', 
              borderRadius: '8px', 
              backgroundColor: '#ca8a04', 
              color: 'white', 
              border: 'none', 
              fontWeight: 'bold', 
              cursor: 'pointer' 
            }}
            onClick={() => alert(`جاري الدخول للغرفة: ${room}`)}
          >
            دخول الغرفة
          </button>
          
          <button 
            style={{ 
              width: '100%', 
              padding: '12px', 
              borderRadius: '8px', 
              backgroundColor: '#475569', 
              color: 'white', 
              border: 'none', 
              fontWeight: 'bold', 
              cursor: 'pointer' 
            }}
          >
            إنشاء غرفة جديدة
          </button>
        </div>
      </div>
    </div>
  );
}
