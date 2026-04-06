import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

type Msg = { role: "user" | "assistant"; content: string };

interface ChatState {
  messages: Msg[];
  isLoading: boolean;
}

interface ChatContextType {
  /** Get messages for a specific chat channel (e.g. "agent", "demo") */
  getMessages: (channel: string) => Msg[];
  /** Set all messages for a channel */
  setMessages: (channel: string, msgs: Msg[]) => void;
  /** Append or update the last assistant message for streaming */
  upsertAssistant: (channel: string, fullText: string) => void;
  /** Add a user message */
  addUserMessage: (channel: string, content: string) => void;
  /** Loading state per channel */
  isLoading: (channel: string) => boolean;
  setLoading: (channel: string, loading: boolean) => void;
  /** Clear chat history for a channel */
  clearChat: (channel: string) => void;
}

const ChatContext = createContext<ChatContextType | null>(null);

const DEFAULT_MESSAGES: Record<string, Msg[]> = {
  agent: [
    { role: "assistant", content: "Agent ready. I can analyze Kalshi event contracts, execute limit orders, check your portfolio, and cancel open orders. Active strategies are loaded automatically.\n\nTry: **\"Go trade\"** or **\"Analyze the top markets\"** or **\"Check my portfolio\"**" },
  ],
  demo: [
    { role: "assistant", content: "Paper trading agent ready. I'll simulate trades using real market data — no real money at risk.\n\nTry: **\"Find me a good trade\"** or **\"What markets are hot right now?\"**" },
  ],
};

export function ChatProvider({ children }: { children: ReactNode }) {
  const [chats, setChats] = useState<Record<string, ChatState>>({});

  const getMessages = useCallback((channel: string): Msg[] => {
    return chats[channel]?.messages ?? DEFAULT_MESSAGES[channel] ?? [];
  }, [chats]);

  const setMessages = useCallback((channel: string, msgs: Msg[]) => {
    setChats(prev => ({
      ...prev,
      [channel]: { ...prev[channel], messages: msgs, isLoading: prev[channel]?.isLoading ?? false },
    }));
  }, []);

  const addUserMessage = useCallback((channel: string, content: string) => {
    setChats(prev => {
      const existing = prev[channel]?.messages ?? DEFAULT_MESSAGES[channel] ?? [];
      return {
        ...prev,
        [channel]: { messages: [...existing, { role: "user", content }], isLoading: prev[channel]?.isLoading ?? false },
      };
    });
  }, []);

  const upsertAssistant = useCallback((channel: string, fullText: string) => {
    setChats(prev => {
      const existing = prev[channel]?.messages ?? DEFAULT_MESSAGES[channel] ?? [];
      const last = existing[existing.length - 1];
      if (last?.role === "assistant" && existing.length > (DEFAULT_MESSAGES[channel]?.length ?? 0)) {
        // Update existing assistant message (streaming)
        const updated = [...existing];
        updated[updated.length - 1] = { role: "assistant", content: fullText };
        return { ...prev, [channel]: { ...prev[channel], messages: updated, isLoading: prev[channel]?.isLoading ?? false } };
      }
      // Append new assistant message
      return { ...prev, [channel]: { ...prev[channel], messages: [...existing, { role: "assistant", content: fullText }], isLoading: prev[channel]?.isLoading ?? false } };
    });
  }, []);

  const isLoading = useCallback((channel: string): boolean => {
    return chats[channel]?.isLoading ?? false;
  }, [chats]);

  const setLoading = useCallback((channel: string, loading: boolean) => {
    setChats(prev => ({
      ...prev,
      [channel]: { messages: prev[channel]?.messages ?? DEFAULT_MESSAGES[channel] ?? [], isLoading: loading },
    }));
  }, []);

  const clearChat = useCallback((channel: string) => {
    setChats(prev => ({
      ...prev,
      [channel]: { messages: DEFAULT_MESSAGES[channel] ?? [], isLoading: false },
    }));
  }, []);

  return (
    <ChatContext.Provider value={{ getMessages, setMessages, upsertAssistant, addUserMessage, isLoading, setLoading, clearChat }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat(channel: string) {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return {
    messages: ctx.getMessages(channel),
    setMessages: (msgs: Msg[]) => ctx.setMessages(channel, msgs),
    addUserMessage: (content: string) => ctx.addUserMessage(channel, content),
    upsertAssistant: (fullText: string) => ctx.upsertAssistant(channel, fullText),
    isLoading: ctx.isLoading(channel),
    setLoading: (loading: boolean) => ctx.setLoading(channel, loading),
    clearChat: () => ctx.clearChat(channel),
  };
}
