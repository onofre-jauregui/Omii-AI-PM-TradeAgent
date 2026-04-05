export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      api_keys: {
        Row: {
          created_at: string
          encrypted_secret: string
          id: string
          key_id: string
          provider: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          encrypted_secret?: string
          id?: string
          key_id?: string
          provider: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          encrypted_secret?: string
          id?: string
          key_id?: string
          provider?: string
          updated_at?: string
        }
        Relationships: []
      }
      compliance_log: {
        Row: {
          created_at: string
          event_type: string
          id: string
          message: string
          metadata: Json | null
          severity: string
          trade_id: string | null
        }
        Insert: {
          created_at?: string
          event_type?: string
          id?: string
          message?: string
          metadata?: Json | null
          severity?: string
          trade_id?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          message?: string
          metadata?: Json | null
          severity?: string
          trade_id?: string | null
        }
        Relationships: []
      }
      risk_settings: {
        Row: {
          auto_stop_loss: boolean
          default_order_type: string
          id: string
          max_daily_loss: number
          max_drawdown_pct: number
          max_open_positions: number
          max_position_size: number
          stop_loss_pct: number
          updated_at: string
        }
        Insert: {
          auto_stop_loss?: boolean
          default_order_type?: string
          id?: string
          max_daily_loss?: number
          max_drawdown_pct?: number
          max_open_positions?: number
          max_position_size?: number
          stop_loss_pct?: number
          updated_at?: string
        }
        Update: {
          auto_stop_loss?: boolean
          default_order_type?: string
          id?: string
          max_daily_loss?: number
          max_drawdown_pct?: number
          max_open_positions?: number
          max_position_size?: number
          stop_loss_pct?: number
          updated_at?: string
        }
        Relationships: []
      }
      strategies: {
        Row: {
          active: boolean
          created_at: string
          description: string
          id: string
          instructions: string
          mode: string
          name: string
          starting_balance: number
        }
        Insert: {
          active?: boolean
          created_at?: string
          description?: string
          id: string
          instructions?: string
          mode?: string
          name: string
          starting_balance?: number
        }
        Update: {
          active?: boolean
          created_at?: string
          description?: string
          id?: string
          instructions?: string
          mode?: string
          name?: string
          starting_balance?: number
        }
        Relationships: []
      }
      trades: {
        Row: {
          action: string
          amount: number
          created_at: string
          filled_price: number | null
          id: string
          market_id: string
          market_question: string
          mode: string
          notes: string | null
          order_id: string | null
          order_type: string | null
          pnl: number | null
          price: number
          side: string
          status: string
          strategy: string | null
          strategy_id: string | null
          ticker: string | null
        }
        Insert: {
          action: string
          amount: number
          created_at?: string
          filled_price?: number | null
          id?: string
          market_id: string
          market_question: string
          mode?: string
          notes?: string | null
          order_id?: string | null
          order_type?: string | null
          pnl?: number | null
          price: number
          side: string
          status?: string
          strategy?: string | null
          strategy_id?: string | null
          ticker?: string | null
        }
        Update: {
          action?: string
          amount?: number
          created_at?: string
          filled_price?: number | null
          id?: string
          market_id?: string
          market_question?: string
          mode?: string
          notes?: string | null
          order_id?: string | null
          order_type?: string | null
          pnl?: number | null
          price?: number
          side?: string
          status?: string
          strategy?: string | null
          strategy_id?: string | null
          ticker?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
