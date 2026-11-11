"use client";

import React, { useState } from 'react';

const Home: React.FC = () => {
  const [message, setMessage] = useState('');
  const [chat, setChat] = useState<{ sender: 'user' | 'agent'; text: string }[]>([]);
  const handleSendMessage = async () => {
    setChat((prevChat) => [...prevChat, { sender: 'user', text: message }]);
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await response.json();
    setChat((prevChat) => [...prevChat, { sender: 'agent', text: data.response }]);
    setMessage('');
  };

  return (
    <div>
      <h1>PayPal Chat Interface</h1>
      <div>
        {chat.map((c, index) => (
          <div key={index} className={c.sender}>
            {c.sender}: {c.text}
          </div>
        ))}
      </div>
      <input
        type="text"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <button onClick={handleSendMessage}>Send</button>
    </div>
  );
};

export default Home;