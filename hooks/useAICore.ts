import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChatMessage } from '../types';
import aiCore from '../services/gemini/aiCore';

interface UseAICoreProps {
  pageContext: string;
  isAiCoreReady: boolean;
}

export const useAICore = ({ pageContext, isAiCoreReady }: UseAICoreProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const isInitializedRef = useRef(false);

  const addMessage = (message: Omit<ChatMessage, 'id'>) => {
    setMessages(prev => [...prev, { ...message, id: self.crypto.randomUUID() }]);
  };

  useEffect(() => {
    if (isInitializedRef.current) return;
    
    if (isAiCoreReady && aiCore.isInitialized()) {
      isInitializedRef.current = true;
      addMessage({
        role: 'model',
        text: 'Hello! I\'m ProBot, your expert arborist and TreePro AI assistant. I have full access to your business data and can help you with:\n\n• **Business questions** - Ask about customers, leads, jobs, revenue\n• **Arborist expertise** - Tree identification, pruning, safety standards\n• **App automation** - Create records, navigate pages, schedule jobs\n\nWhat can I help you with today?'
      });
      setIsInitializing(false);
    }
  }, [isAiCoreReady]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async (messageText: string) => {
    const userMessage = messageText.trim();
    if (!userMessage || isInitializing) return;

    setIsLoading(true);
    setError(null);
    addMessage({ role: 'user', text: userMessage });
    setInputValue('');

    try {
      const result = await aiCore.chat(userMessage, messages);

      if (result.functionCalls && result.functionCalls.length > 0) {
        for (const call of result.functionCalls) {
          addMessage({
            role: 'tool',
            text: `🔧 **Executing:** \`${call.name}\`\n\`\`\`json\n${JSON.stringify(call.args, null, 2)}\n\`\`\``,
            isThinking: true
          });

          if (call.result.action === 'navigate' && call.result.path) {
            console.log('🧭 Navigation requested:', call.result.path);
            navigate(call.result.path);
            
            addMessage({
              role: 'tool',
              text: `✅ **Navigated to:** ${call.result.path}`,
              isThinking: false
            });
          } else {
            addMessage({
              role: 'tool',
              text: `✅ **Result:** ${call.result.message || JSON.stringify(call.result, null, 2)}`,
              isThinking: false
            });
          }
        }
      }

      if (result.response) {
        addMessage({ role: 'model', text: result.response });
      }
    } catch (err: any) {
      console.error('❌ Error sending message:', err);
      setError(`Error: ${err.message}`);
      addMessage({
        role: 'model',
        text: '⚠️ Sorry, I encountered an error processing your request. Please try again.'
      });
    } finally {
      setIsLoading(false);
    }
  }, [messages, isInitializing, navigate]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(inputValue);
  };

  return {
    messages,
    inputValue,
    setInputValue,
    handleSubmit,
    isLoading: isLoading || isInitializing,
    error,
    messagesEndRef,
    sendMessage,
  };
};