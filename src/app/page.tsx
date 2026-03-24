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
      direction: 'rtl',
      margin: 0,
      padding: '20px'
    }}>
      <div style={{ 
        backgroundColor: '#1e293b', 
        padding: '40px', 
        borderRadius: '20px', 
        textAlign: 'center', 
        boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
        width: '100%',
        maxWidth: '400px',
        border: '1px solid #334155'
      }}>
        <h1 style={{ color: '#eab308', fontSize: '2.5rem', marginBottom: '30px' }}>لعبة السبيطة</h1>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
          <input 
            type="text" 
            placeholder="أدخل رقم الغرفة"
            style={{ 
              width: '100%', 
              padding: '15px', 
              borderRadius: '10px', 
              border: '2px solid #475569', 
              backgroundColor: '#334155', 
              color: 'white', 
              textAlign: 'center',
              fontSize: '1rem',
              outline: 'none'
            }}
            value={room}
            onChange={(e) => setRoom(e.target.value)}
          />
          
          <button 
            style={{ 
              width: '100%', 
              padding: '15px', 
              borderRadius: '10px', 
              backgroundColor: '#ca8a04', 
              color: 'white', 
              border: 'none', 
              fontWeight: 'bold', 
              fontSize: '1.1rem',
              cursor: 'pointer',
              transition: 'background 0.3s'
            }}
            onClick={() => alert(`جاري الدخول للغرفة: ${room}`)}
          >
            دخول الغرفة
          </button>
          
          <button 
            style={{ 
              width: '100%', 
              padding: '15px', 
              borderRadius: '10px', 
              backgroundColor: '#475569', 
              color: 'white', 
              border: 'none', 
              fontWeight: 'bold', 
              fontSize: '1.1rem',
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
