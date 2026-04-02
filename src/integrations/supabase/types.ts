export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      trades: {
        Row: {
          id: string
          ticker: string | null
          market_id: string
          market_question: string
          side: string
          action: string
          price: number
          amount: number
          strategy: string | null
          mode: string
          status: string
          pnl: number | null
          notes: string | null
          order_id: string | null
          order_type: string | null
          time_in_force: string | null
          expiration_ts: string | null
          filled_price: number | null
          filled_at: string | null
          cancelled_at: string | null
          exchange: string | null
          created_at: string
        }
        Insert: {
          id?: string
          ticker?: string | null
          market_id: string
          market_question: string
          side: string
          action: string
          price: number
          amount: number
          strategy?: string | null
          mode?: string
          status?: string
          pnl?: number | null
          notes?: string | null
          order_id?: string | null
          order_type?: string | null
          time_in_force?: string | null
          expiration_ts?: string | null
          filled_price?: number | null
          filled_at?: string | null
          cancelled_at?: string | null
          exchange?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          ticker?: string | null
          market_id?: string
          market_question?: string
          side?: string
          action?: string
          price?: number
          amount?: number
          strategy?: string | null
          mode?: string
          status?: string
          pnl?: number | null
          notes?: string | null
          order_id?: string | null
          order_type?: string | null
          time_in_force?: string | null
          expiration_ts?: string | null
          filled_price?: number | null
          filled_at?: string | null
          cancelled_at?: string | null
          exchange?: string | null
          created_at?: string
        }
        Relationships: []
      }
      compliance_log: {
        Row: {
          id: string
          trade_id: string | null
          event_type: string
          severity: string
          message: string
          metadata: Json
          created_at: string
        }
        Insert: {
          id?: string
          trade_id?: string | null
          event_type: string
          severity?: string
          message: string
          metadata?: Json
          created_at?: string
        }
        Update: {
          id?: string
          trade_id?: string | null
          event_type?: string
          severity?: string
          message?: string
          metadata?: Json
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "compliance_log_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          }
        ]
      }
      risk_state: {
        Row: {
          id: string
          date: string
          daily_pnl: number
          daily_trades: number
          open_position_count: number
          open_position_value: number
          max_drawdown_today: number
          peak_portfolio_value: number
          is_trading_halted: boolean
          halt_reason: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          date?: string
          daily_pnl?: number
          daily_trades?: number
          open_position_count?: number
          open_position_value?: number
          max_drawdown_today?: number
          peak_portfolio_value?: number
          is_trading_halted?: boolean
          halt_reason?: string | null
          updated_at?: string
        }
        Update: {
          id?: string
          date?: string
          daily_pnl?: number
          daily_trades?: number
          open_position_count?: number
          open_position_value?: number
          max_drawdown_today?: number
          peak_portfolio_value?: number
          is_trading_halted?: boolean
          halt_reason?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      risk_settings: {
        Row: {
          id: string
          max_daily_loss: number
          max_drawdown_pct: number
          max_position_size: number
          max_open_positions: number
          auto_stop_loss: boolean
          stop_loss_pct: number
          default_order_type: string
          updated_at: string
        }
        Insert: {
          id?: string
          max_daily_loss?: number
          max_drawdown_pct?: number
          max_position_size?: number
          max_open_positions?: number
          auto_stop_loss?: boolean
          stop_loss_pct?: number
          default_order_type?: string
          updated_at?: string
        }
        Update: {
          id?: string
          max_daily_loss?: number
          max_drawdown_pct?: number
          max_position_size?: number
          max_open_positions?: number
          auto_stop_loss?: boolean
          stop_loss_pct?: number
          default_order_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      api_keys: {
        Row: {
          id: string
          provider: string
          key_id: string
          encrypted_secret: string
          is_valid: boolean | null
          last_validated_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          provider: string
          key_id: string
          encrypted_secret: string
          is_valid?: boolean | null
          last_validated_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          provider?: string
          key_id?: string
          encrypted_secret?: string
          is_valid?: boolean | null
          last_validated_at?: string | null
          created_at?: string
          updated_at?: string
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
