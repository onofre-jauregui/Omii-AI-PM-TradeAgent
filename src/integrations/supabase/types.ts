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
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      agent_memory: {
        Row: {
          alpha: number | null
          beta: number | null
          child_count: number | null
          confidence: number
          confirmations: number
          content: string
          contradictions: number
          created_at: string
          exposed_confidence: number | null
          id: string
          is_active: boolean
          last_recalled_at: string | null
          last_updated_at: string | null
          market_context: Json | null
          memory_type: string
          merged_into: string | null
          quarantined_at: string | null
          related_trade_ids: string[] | null
          scope: string | null
          source_type: string
          strategy_id: string | null
          summary: string | null
          system_version: string | null
          tags: string[] | null
          title: string
          token_estimate: number | null
          trade_sample_size: number | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          alpha?: number | null
          beta?: number | null
          child_count?: number | null
          confidence?: number
          confirmations?: number
          content: string
          contradictions?: number
          created_at?: string
          exposed_confidence?: number | null
          id?: string
          is_active?: boolean
          last_recalled_at?: string | null
          last_updated_at?: string | null
          market_context?: Json | null
          memory_type?: string
          merged_into?: string | null
          quarantined_at?: string | null
          related_trade_ids?: string[] | null
          scope?: string | null
          source_type?: string
          strategy_id?: string | null
          summary?: string | null
          system_version?: string | null
          tags?: string[] | null
          title: string
          token_estimate?: number | null
          trade_sample_size?: number | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          alpha?: number | null
          beta?: number | null
          child_count?: number | null
          confidence?: number
          confirmations?: number
          content?: string
          contradictions?: number
          created_at?: string
          exposed_confidence?: number | null
          id?: string
          is_active?: boolean
          last_recalled_at?: string | null
          last_updated_at?: string | null
          market_context?: Json | null
          memory_type?: string
          merged_into?: string | null
          quarantined_at?: string | null
          related_trade_ids?: string[] | null
          scope?: string | null
          source_type?: string
          strategy_id?: string | null
          summary?: string | null
          system_version?: string | null
          tags?: string[] | null
          title?: string
          token_estimate?: number | null
          trade_sample_size?: number | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_memory_merged_into_fkey"
            columns: ["merged_into"]
            isOneToOne: false
            referencedRelation: "agent_memory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_memory_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          created_at: string
          encrypted_secret: string | null
          id: string
          is_valid: boolean | null
          key_id: string | null
          last_validated_at: string | null
          provider: string
          secret_ciphertext: string | null
          secret_iv: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          encrypted_secret?: string | null
          id?: string
          is_valid?: boolean | null
          key_id?: string | null
          last_validated_at?: string | null
          provider: string
          secret_ciphertext?: string | null
          secret_iv?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          encrypted_secret?: string | null
          id?: string
          is_valid?: boolean | null
          key_id?: string | null
          last_validated_at?: string | null
          provider?: string
          secret_ciphertext?: string | null
          secret_iv?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      auto_trade_locks: {
        Row: {
          acquired_at: string
          lock_name: string
          run_id: string
        }
        Insert: {
          acquired_at?: string
          lock_name: string
          run_id: string
        }
        Update: {
          acquired_at?: string
          lock_name?: string
          run_id?: string
        }
        Relationships: []
      }
      backtest_recommendations: {
        Row: {
          applied: boolean | null
          applied_at: string | null
          backtest_run_id: string | null
          created_at: string
          current_value: number | null
          id: string
          param_name: string
          recommended_value: number
          strategy_id: string
          trade_count: number | null
          win_rate_at_rec: number | null
        }
        Insert: {
          applied?: boolean | null
          applied_at?: string | null
          backtest_run_id?: string | null
          created_at?: string
          current_value?: number | null
          id?: string
          param_name: string
          recommended_value: number
          strategy_id: string
          trade_count?: number | null
          win_rate_at_rec?: number | null
        }
        Update: {
          applied?: boolean | null
          applied_at?: string | null
          backtest_run_id?: string | null
          created_at?: string
          current_value?: number | null
          id?: string
          param_name?: string
          recommended_value?: number
          strategy_id?: string
          trade_count?: number | null
          win_rate_at_rec?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "backtest_recommendations_backtest_run_id_fkey"
            columns: ["backtest_run_id"]
            isOneToOne: false
            referencedRelation: "backtest_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      backtest_runs: {
        Row: {
          avg_edge_cents: number | null
          completed_at: string | null
          id: string
          mode: string
          params: Json | null
          results: Json
          sharpe_ratio: number | null
          started_at: string
          strategy_id: string
          total_pnl_cents: number | null
          trade_count: number | null
          triggered_by: string | null
          win_rate: number | null
        }
        Insert: {
          avg_edge_cents?: number | null
          completed_at?: string | null
          id?: string
          mode: string
          params?: Json | null
          results?: Json
          sharpe_ratio?: number | null
          started_at?: string
          strategy_id: string
          total_pnl_cents?: number | null
          trade_count?: number | null
          triggered_by?: string | null
          win_rate?: number | null
        }
        Update: {
          avg_edge_cents?: number | null
          completed_at?: string | null
          id?: string
          mode?: string
          params?: Json | null
          results?: Json
          sharpe_ratio?: number | null
          started_at?: string
          strategy_id?: string
          total_pnl_cents?: number | null
          trade_count?: number | null
          triggered_by?: string | null
          win_rate?: number | null
        }
        Relationships: []
      }
      baskets: {
        Row: {
          abort_reason: string | null
          alert_id: string | null
          completed_at: string | null
          created_at: string | null
          expected_edge_cents: number | null
          id: string
          leg_count: number
          legs_filled: number
          mode: string
          reasoning: string | null
          started_at: string | null
          status: string
          strategy_id: string | null
          strategy_name: string | null
          timeout_at: string | null
          updated_at: string | null
        }
        Insert: {
          abort_reason?: string | null
          alert_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          expected_edge_cents?: number | null
          id?: string
          leg_count?: number
          legs_filled?: number
          mode?: string
          reasoning?: string | null
          started_at?: string | null
          status?: string
          strategy_id?: string | null
          strategy_name?: string | null
          timeout_at?: string | null
          updated_at?: string | null
        }
        Update: {
          abort_reason?: string | null
          alert_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          expected_edge_cents?: number | null
          id?: string
          leg_count?: number
          legs_filled?: number
          mode?: string
          reasoning?: string | null
          started_at?: string | null
          status?: string
          strategy_id?: string | null
          strategy_name?: string | null
          timeout_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "baskets_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "surface_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "baskets_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          role: string
          user_id: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_log: {
        Row: {
          category: string
          created_at: string
          event_type: string
          id: string
          message: string
          metadata: Json | null
          severity: string
          trade_id: string | null
          user_id: string | null
        }
        Insert: {
          category?: string
          created_at?: string
          event_type: string
          id?: string
          message: string
          metadata?: Json | null
          severity?: string
          trade_id?: string | null
          user_id?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          event_type?: string
          id?: string
          message?: string
          metadata?: Json | null
          severity?: string
          trade_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "compliance_log_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          created_at: string
          id: string
          message_count: number | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message_count?: number | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message_count?: number | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      failed_trade_queue: {
        Row: {
          failed_at: string
          failure_reason: string | null
          id: string
          kalshi_status: number | null
          last_retry_at: string | null
          retry_count: number
          status: string
          trace_id: string | null
          trade_payload: Json
          user_id: string
        }
        Insert: {
          failed_at?: string
          failure_reason?: string | null
          id?: string
          kalshi_status?: number | null
          last_retry_at?: string | null
          retry_count?: number
          status?: string
          trace_id?: string | null
          trade_payload: Json
          user_id: string
        }
        Update: {
          failed_at?: string
          failure_reason?: string | null
          id?: string
          kalshi_status?: number | null
          last_retry_at?: string | null
          retry_count?: number
          status?: string
          trace_id?: string | null
          trade_payload?: Json
          user_id?: string
        }
        Relationships: []
      }
      hitl_approvals: {
        Row: {
          decided_at: string | null
          decision_note: string | null
          id: string
          requested_at: string
          status: string
          trace_id: string | null
          trade_payload: Json
          user_id: string
        }
        Insert: {
          decided_at?: string | null
          decision_note?: string | null
          id?: string
          requested_at?: string
          status?: string
          trace_id?: string | null
          trade_payload: Json
          user_id: string
        }
        Update: {
          decided_at?: string | null
          decision_note?: string | null
          id?: string
          requested_at?: string
          status?: string
          trace_id?: string | null
          trade_payload?: Json
          user_id?: string
        }
        Relationships: []
      }
      kalshi_markets_cache: {
        Row: {
          fetched_at: string
          market_data: Json
          market_ticker: string
          series_ticker: string
        }
        Insert: {
          fetched_at?: string
          market_data: Json
          market_ticker: string
          series_ticker: string
        }
        Update: {
          fetched_at?: string
          market_data?: Json
          market_ticker?: string
          series_ticker?: string
        }
        Relationships: []
      }
      memory_attribution: {
        Row: {
          cited_at: string | null
          memory_id: string
          settled_at: string | null
          trade_id: string
          trade_pnl: number | null
        }
        Insert: {
          cited_at?: string | null
          memory_id: string
          settled_at?: string | null
          trade_id: string
          trade_pnl?: number | null
        }
        Update: {
          cited_at?: string | null
          memory_id?: string
          settled_at?: string | null
          trade_id?: string
          trade_pnl?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "memory_attribution_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "agent_memory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_attribution_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          display_name: string | null
          id: string
          is_admin: boolean
          kalshi_username: string | null
          notification_prefs: Json
          onboarding_completed: boolean
          phone: string | null
          trading_mode: string
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          display_name?: string | null
          id: string
          is_admin?: boolean
          kalshi_username?: string | null
          notification_prefs?: Json
          onboarding_completed?: boolean
          phone?: string | null
          trading_mode?: string
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          display_name?: string | null
          id?: string
          is_admin?: boolean
          kalshi_username?: string | null
          notification_prefs?: Json
          onboarding_completed?: boolean
          phone?: string | null
          trading_mode?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      rate_limits: {
        Row: {
          count: number
          endpoint: string
          user_id: string
          window_start: string
        }
        Insert: {
          count?: number
          endpoint: string
          user_id: string
          window_start: string
        }
        Update: {
          count?: number
          endpoint?: string
          user_id?: string
          window_start?: string
        }
        Relationships: []
      }
      risk_settings: {
        Row: {
          allocated_capital: number
          auto_stop_loss: boolean
          default_order_type: string
          id: string
          max_daily_loss: number
          max_daily_trades: number
          max_drawdown_pct: number
          max_open_positions: number
          max_position_size: number
          mode: string
          stop_loss_pct: number
          updated_at: string
          user_id: string | null
        }
        Insert: {
          allocated_capital?: number
          auto_stop_loss?: boolean
          default_order_type?: string
          id?: string
          max_daily_loss?: number
          max_daily_trades?: number
          max_drawdown_pct?: number
          max_open_positions?: number
          max_position_size?: number
          mode?: string
          stop_loss_pct?: number
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          allocated_capital?: number
          auto_stop_loss?: boolean
          default_order_type?: string
          id?: string
          max_daily_loss?: number
          max_daily_trades?: number
          max_drawdown_pct?: number
          max_open_positions?: number
          max_position_size?: number
          mode?: string
          stop_loss_pct?: number
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      risk_state: {
        Row: {
          daily_pnl: number
          daily_trades: number
          date: string
          halt_reason: string | null
          id: string
          is_trading_halted: boolean
          max_drawdown_today: number
          open_position_count: number
          open_position_value: number
          peak_portfolio_value: number
          updated_at: string
          user_id: string | null
        }
        Insert: {
          daily_pnl?: number
          daily_trades?: number
          date?: string
          halt_reason?: string | null
          id?: string
          is_trading_halted?: boolean
          max_drawdown_today?: number
          open_position_count?: number
          open_position_value?: number
          peak_portfolio_value?: number
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          daily_pnl?: number
          daily_trades?: number
          date?: string
          halt_reason?: string | null
          id?: string
          is_trading_halted?: boolean
          max_drawdown_today?: number
          open_position_count?: number
          open_position_value?: number
          peak_portfolio_value?: number
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      signals: {
        Row: {
          acted_on_at: string | null
          composite_score: number | null
          created_at: string | null
          days_to_close: number | null
          direction: string
          edge_cents: number | null
          edge_score: number | null
          event_ticker: string | null
          expires_at: string | null
          id: string
          implied_probability: number | null
          liquidity_score: number | null
          market_question: string | null
          metadata: Json | null
          mid_price: number | null
          no_ask: number | null
          no_bid: number | null
          outcome_correct: boolean | null
          outcome_pnl: number | null
          reasoning: string | null
          signal_strength: string
          source: string | null
          spread: number | null
          ticker: string
          time_value_score: number | null
          true_probability: number | null
          volume: number | null
          volume_rank_score: number | null
          was_acted_on: boolean | null
          yes_ask: number | null
          yes_bid: number | null
        }
        Insert: {
          acted_on_at?: string | null
          composite_score?: number | null
          created_at?: string | null
          days_to_close?: number | null
          direction: string
          edge_cents?: number | null
          edge_score?: number | null
          event_ticker?: string | null
          expires_at?: string | null
          id?: string
          implied_probability?: number | null
          liquidity_score?: number | null
          market_question?: string | null
          metadata?: Json | null
          mid_price?: number | null
          no_ask?: number | null
          no_bid?: number | null
          outcome_correct?: boolean | null
          outcome_pnl?: number | null
          reasoning?: string | null
          signal_strength: string
          source?: string | null
          spread?: number | null
          ticker: string
          time_value_score?: number | null
          true_probability?: number | null
          volume?: number | null
          volume_rank_score?: number | null
          was_acted_on?: boolean | null
          yes_ask?: number | null
          yes_bid?: number | null
        }
        Update: {
          acted_on_at?: string | null
          composite_score?: number | null
          created_at?: string | null
          days_to_close?: number | null
          direction?: string
          edge_cents?: number | null
          edge_score?: number | null
          event_ticker?: string | null
          expires_at?: string | null
          id?: string
          implied_probability?: number | null
          liquidity_score?: number | null
          market_question?: string | null
          metadata?: Json | null
          mid_price?: number | null
          no_ask?: number | null
          no_bid?: number | null
          outcome_correct?: boolean | null
          outcome_pnl?: number | null
          reasoning?: string | null
          signal_strength?: string
          source?: string | null
          spread?: number | null
          ticker?: string
          time_value_score?: number | null
          true_probability?: number | null
          volume?: number | null
          volume_rank_score?: number | null
          was_acted_on?: boolean | null
          yes_ask?: number | null
          yes_bid?: number | null
        }
        Relationships: []
      }
      spread_history: {
        Row: {
          created_at: string
          id: string
          open_interest: number | null
          snapshot_at: string
          spread: number | null
          strategy_id: string | null
          ticker: string
          volume: number | null
          yes_ask: number | null
          yes_bid: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          open_interest?: number | null
          snapshot_at?: string
          spread?: number | null
          strategy_id?: string | null
          ticker: string
          volume?: number | null
          yes_ask?: number | null
          yes_bid?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          open_interest?: number | null
          snapshot_at?: string
          spread?: number | null
          strategy_id?: string | null
          ticker?: string
          volume?: number | null
          yes_ask?: number | null
          yes_bid?: number | null
        }
        Relationships: []
      }
      strategies: {
        Row: {
          active: boolean
          created_at: string
          description: string
          expected_hit_rate: number | null
          id: string
          instructions: string
          last_run_at: string | null
          max_acceptable_drawdown: number | null
          mode: string
          name: string
          run_interval_minutes: number | null
          starting_balance: number
          suspended_until: string | null
          suspension_reason: string | null
          template_id: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          description?: string
          expected_hit_rate?: number | null
          id: string
          instructions?: string
          last_run_at?: string | null
          max_acceptable_drawdown?: number | null
          mode?: string
          name: string
          run_interval_minutes?: number | null
          starting_balance?: number
          suspended_until?: string | null
          suspension_reason?: string | null
          template_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          description?: string
          expected_hit_rate?: number | null
          id?: string
          instructions?: string
          last_run_at?: string | null
          max_acceptable_drawdown?: number | null
          mode?: string
          name?: string
          run_interval_minutes?: number | null
          starting_balance?: number
          suspended_until?: string | null
          suspension_reason?: string | null
          template_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      strategy_config: {
        Row: {
          basket_timeout_seconds: number
          consecutive_failures: number
          excluded_cities: string[] | null
          halt_reason: string | null
          is_halted: boolean
          max_consecutive_failures: number
          max_days_to_close: number
          max_legs: number
          max_position_usd: number
          min_composite_score: number
          min_days_to_close: number
          min_edge_cents: number
          min_liquidity_score: number
          min_position_usd: number
          min_post_fill_edge_cents: number
          strategy_id: string
          updated_at: string | null
        }
        Insert: {
          basket_timeout_seconds?: number
          consecutive_failures?: number
          excluded_cities?: string[] | null
          halt_reason?: string | null
          is_halted?: boolean
          max_consecutive_failures?: number
          max_days_to_close?: number
          max_legs?: number
          max_position_usd?: number
          min_composite_score?: number
          min_days_to_close?: number
          min_edge_cents?: number
          min_liquidity_score?: number
          min_position_usd?: number
          min_post_fill_edge_cents?: number
          strategy_id: string
          updated_at?: string | null
        }
        Update: {
          basket_timeout_seconds?: number
          consecutive_failures?: number
          excluded_cities?: string[] | null
          halt_reason?: string | null
          is_halted?: boolean
          max_consecutive_failures?: number
          max_days_to_close?: number
          max_legs?: number
          max_position_usd?: number
          min_composite_score?: number
          min_days_to_close?: number
          min_edge_cents?: number
          min_liquidity_score?: number
          min_position_usd?: number
          min_post_fill_edge_cents?: number
          strategy_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "strategy_config_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: true
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      strategy_snapshots: {
        Row: {
          balance: number
          id: string
          losing_trades: number
          open_positions: number
          recorded_at: string
          strategy_id: string
          total_pnl: number
          total_trades: number
          user_id: string | null
          winning_trades: number
        }
        Insert: {
          balance: number
          id?: string
          losing_trades?: number
          open_positions?: number
          recorded_at?: string
          strategy_id: string
          total_pnl?: number
          total_trades?: number
          user_id?: string | null
          winning_trades?: number
        }
        Update: {
          balance?: number
          id?: string
          losing_trades?: number
          open_positions?: number
          recorded_at?: string
          strategy_id?: string
          total_pnl?: number
          total_trades?: number
          user_id?: string | null
          winning_trades?: number
        }
        Relationships: [
          {
            foreignKeyName: "strategy_snapshots_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_events: {
        Row: {
          error_message: string | null
          id: string
          payload: Json
          processed_at: string
          status: string
          type: string
          user_id: string | null
        }
        Insert: {
          error_message?: string | null
          id: string
          payload: Json
          processed_at?: string
          status?: string
          type: string
          user_id?: string | null
        }
        Update: {
          error_message?: string | null
          id?: string
          payload?: Json
          processed_at?: string
          status?: string
          type?: string
          user_id?: string | null
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          max_markets_watched: number | null
          max_open_positions: number | null
          max_position_usd: number | null
          max_trades_per_day: number | null
          status: string
          stripe_customer_id: string | null
          stripe_price_id: string | null
          stripe_subscription_id: string | null
          tier: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          max_markets_watched?: number | null
          max_open_positions?: number | null
          max_position_usd?: number | null
          max_trades_per_day?: number | null
          status?: string
          stripe_customer_id?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          tier?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          max_markets_watched?: number | null
          max_open_positions?: number | null
          max_position_usd?: number | null
          max_trades_per_day?: number | null
          status?: string
          stripe_customer_id?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
          tier?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      surface_alerts: {
        Row: {
          action: string | null
          alert_type: string
          confidence: number | null
          created_at: string | null
          description: string | null
          detected_at: string | null
          event_ticker: string
          expected_edge_cents: number
          exploited_at: string | null
          exploited_by_trade_id: string | null
          id: string
          is_exploited: boolean | null
          price_a_cents: number | null
          price_b_cents: number | null
          ticker_a: string
          ticker_b: string | null
        }
        Insert: {
          action?: string | null
          alert_type: string
          confidence?: number | null
          created_at?: string | null
          description?: string | null
          detected_at?: string | null
          event_ticker: string
          expected_edge_cents: number
          exploited_at?: string | null
          exploited_by_trade_id?: string | null
          id?: string
          is_exploited?: boolean | null
          price_a_cents?: number | null
          price_b_cents?: number | null
          ticker_a: string
          ticker_b?: string | null
        }
        Update: {
          action?: string | null
          alert_type?: string
          confidence?: number | null
          created_at?: string | null
          description?: string | null
          detected_at?: string | null
          event_ticker?: string
          expected_edge_cents?: number
          exploited_at?: string | null
          exploited_by_trade_id?: string | null
          id?: string
          is_exploited?: boolean | null
          price_a_cents?: number | null
          price_b_cents?: number | null
          ticker_a?: string
          ticker_b?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "surface_alerts_exploited_by_trade_id_fkey"
            columns: ["exploited_by_trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_lessons: {
        Row: {
          confidence: number | null
          created_at: string | null
          do_differently: string | null
          id: string
          lesson: string
          lesson_type: string
          outcome: string | null
          strategy_id: string | null
          tags: string[] | null
          ticker: string
          trade_context: Json | null
          trade_id: string | null
          user_id: string | null
        }
        Insert: {
          confidence?: number | null
          created_at?: string | null
          do_differently?: string | null
          id?: string
          lesson: string
          lesson_type: string
          outcome?: string | null
          strategy_id?: string | null
          tags?: string[] | null
          ticker: string
          trade_context?: Json | null
          trade_id?: string | null
          user_id?: string | null
        }
        Update: {
          confidence?: number | null
          created_at?: string | null
          do_differently?: string | null
          id?: string
          lesson?: string
          lesson_type?: string
          outcome?: string | null
          strategy_id?: string | null
          tags?: string[] | null
          ticker?: string
          trade_context?: Json | null
          trade_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trade_lessons_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_reflections: {
        Row: {
          actual_outcome: string | null
          actual_pnl: number | null
          analysis: string | null
          created_at: string
          decision_quality: string | null
          expected_confidence: number | null
          expected_outcome: string
          id: string
          lesson_id: string | null
          root_cause: string | null
          trade_id: string
          user_id: string | null
        }
        Insert: {
          actual_outcome?: string | null
          actual_pnl?: number | null
          analysis?: string | null
          created_at?: string
          decision_quality?: string | null
          expected_confidence?: number | null
          expected_outcome: string
          id?: string
          lesson_id?: string | null
          root_cause?: string | null
          trade_id: string
          user_id?: string | null
        }
        Update: {
          actual_outcome?: string | null
          actual_pnl?: number | null
          analysis?: string | null
          created_at?: string
          decision_quality?: string | null
          expected_confidence?: number | null
          expected_outcome?: string
          id?: string
          lesson_id?: string | null
          root_cause?: string | null
          trade_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trade_reflections_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "agent_memory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_reflections_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trades: {
        Row: {
          action: string
          amount: number
          basket_id: string | null
          cancelled_at: string | null
          created_at: string
          exchange: string | null
          exit_reason: string | null
          expiration_time: string | null
          expiration_ts: string | null
          filled_at: string | null
          filled_price: number | null
          id: string
          influenced_by_memory_ids: string[] | null
          market_id: string
          market_question: string
          mode: string
          notes: string | null
          order_id: string | null
          order_type: string | null
          pnl: number | null
          price: number
          resolution: string | null
          settled_at: string | null
          side: string
          slippage_cents: number | null
          source_signal_id: string | null
          status: string
          strategy: string | null
          strategy_id: string | null
          system_version: string | null
          ticker: string | null
          time_in_force: string | null
          trace_id: string | null
          user_id: string | null
          user_rating: string | null
        }
        Insert: {
          action: string
          amount: number
          basket_id?: string | null
          cancelled_at?: string | null
          created_at?: string
          exchange?: string | null
          exit_reason?: string | null
          expiration_time?: string | null
          expiration_ts?: string | null
          filled_at?: string | null
          filled_price?: number | null
          id?: string
          influenced_by_memory_ids?: string[] | null
          market_id: string
          market_question: string
          mode?: string
          notes?: string | null
          order_id?: string | null
          order_type?: string | null
          pnl?: number | null
          price: number
          resolution?: string | null
          settled_at?: string | null
          side: string
          slippage_cents?: number | null
          source_signal_id?: string | null
          status?: string
          strategy?: string | null
          strategy_id?: string | null
          system_version?: string | null
          ticker?: string | null
          time_in_force?: string | null
          trace_id?: string | null
          user_id?: string | null
          user_rating?: string | null
        }
        Update: {
          action?: string
          amount?: number
          basket_id?: string | null
          cancelled_at?: string | null
          created_at?: string
          exchange?: string | null
          exit_reason?: string | null
          expiration_time?: string | null
          expiration_ts?: string | null
          filled_at?: string | null
          filled_price?: number | null
          id?: string
          influenced_by_memory_ids?: string[] | null
          market_id?: string
          market_question?: string
          mode?: string
          notes?: string | null
          order_id?: string | null
          order_type?: string | null
          pnl?: number | null
          price?: number
          resolution?: string | null
          settled_at?: string | null
          side?: string
          slippage_cents?: number | null
          source_signal_id?: string | null
          status?: string
          strategy?: string | null
          strategy_id?: string | null
          system_version?: string | null
          ticker?: string | null
          time_in_force?: string | null
          trace_id?: string | null
          user_id?: string | null
          user_rating?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trades_basket_id_fkey"
            columns: ["basket_id"]
            isOneToOne: false
            referencedRelation: "baskets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      waitlist: {
        Row: {
          created_at: string | null
          email: string
          id: string
          plan_interest: string | null
        }
        Insert: {
          created_at?: string | null
          email: string
          id?: string
          plan_interest?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string
          id?: string
          plan_interest?: string | null
        }
        Relationships: []
      }
      weather_bucket_calibration: {
        Row: {
          bucket_threshold: number
          created_at: string | null
          id: string
          location_code: string
          pnl: number | null
          side: string | null
          ticker: string | null
          trade_date: string
          yes_resolved: boolean
        }
        Insert: {
          bucket_threshold: number
          created_at?: string | null
          id?: string
          location_code: string
          pnl?: number | null
          side?: string | null
          ticker?: string | null
          trade_date: string
          yes_resolved: boolean
        }
        Update: {
          bucket_threshold?: number
          created_at?: string | null
          id?: string
          location_code?: string
          pnl?: number | null
          side?: string | null
          ticker?: string | null
          trade_date?: string
          yes_resolved?: boolean
        }
        Relationships: []
      }
      weather_calibration: {
        Row: {
          bias_fahrenheit: number
          created_at: string | null
          date_range_end: string | null
          date_range_start: string | null
          id: string
          last_backtest_at: string | null
          location: string
          mad_fahrenheit: number
          model_source: string
          rmse_fahrenheit: number
          sample_count: number
          updated_at: string | null
        }
        Insert: {
          bias_fahrenheit?: number
          created_at?: string | null
          date_range_end?: string | null
          date_range_start?: string | null
          id?: string
          last_backtest_at?: string | null
          location: string
          mad_fahrenheit?: number
          model_source?: string
          rmse_fahrenheit?: number
          sample_count?: number
          updated_at?: string | null
        }
        Update: {
          bias_fahrenheit?: number
          created_at?: string | null
          date_range_end?: string | null
          date_range_start?: string | null
          id?: string
          last_backtest_at?: string | null
          location?: string
          mad_fahrenheit?: number
          model_source?: string
          rmse_fahrenheit?: number
          sample_count?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      weather_forecasts: {
        Row: {
          expected_high: number | null
          fetched_at: string
          forecast_date: string
          high_temp_distribution: Json
          id: string
          location: string
          raw_payload: Json | null
          source: string
          std_dev: number | null
        }
        Insert: {
          expected_high?: number | null
          fetched_at?: string
          forecast_date: string
          high_temp_distribution: Json
          id?: string
          location: string
          raw_payload?: Json | null
          source: string
          std_dev?: number | null
        }
        Update: {
          expected_high?: number | null
          fetched_at?: string
          forecast_date?: string
          high_temp_distribution?: Json
          id?: string
          location?: string
          raw_payload?: Json | null
          source?: string
          std_dev?: number | null
        }
        Relationships: []
      }
      weather_markets_cache: {
        Row: {
          bucket_high: number
          bucket_low: number
          fetched_at: string
          forecast_date: string
          last_price: number | null
          location: string
          market_question: string | null
          ticker: string
          yes_ask: number | null
          yes_bid: number | null
        }
        Insert: {
          bucket_high: number
          bucket_low: number
          fetched_at?: string
          forecast_date: string
          last_price?: number | null
          location: string
          market_question?: string | null
          ticker: string
          yes_ask?: number | null
          yes_bid?: number | null
        }
        Update: {
          bucket_high?: number
          bucket_low?: number
          fetched_at?: string
          forecast_date?: string
          last_price?: number | null
          location?: string
          market_question?: string | null
          ticker?: string
          yes_ask?: number | null
          yes_bid?: number | null
        }
        Relationships: []
      }
    }
    Views: {
      agent_activity_daily: {
        Row: {
          avg_fill_price: number | null
          capital_deployed: number | null
          day: string | null
          realized_pnl: number | null
          strategies_used: number | null
          trades_cancelled: number | null
          trades_failed: number | null
          trades_filled: number | null
          trades_total: number | null
          unique_markets: number | null
        }
        Relationships: []
      }
      agent_cron_health: {
        Row: {
          active: boolean | null
          expected_interval_s: number | null
          is_stale: boolean | null
          jobname: string | null
          last_run_failed: boolean | null
          last_started_at: string | null
          last_status: string | null
          schedule: string | null
          seconds_since_last_run: number | null
        }
        Relationships: []
      }
      agent_recent_trades: {
        Row: {
          action: string | null
          created_at: string | null
          entry: string | null
          expected_confidence: number | null
          expected_outcome: string | null
          llm_rationale: string | null
          market_question: string | null
          mode: string | null
          side: string | null
          size_usd: number | null
          status: string | null
          strategy_id: string | null
          ticker: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trades_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_signal_health: {
        Row: {
          actionable: number | null
          avg_composite: number | null
          hour: string | null
          s002_eligible: number | null
          short_horizon: number | null
          signals_generated: number | null
          strong: number | null
        }
        Relationships: []
      }
      agent_strategy_performance: {
        Row: {
          capital_deployed: number | null
          first_trade: string | null
          halt_reason: string | null
          is_halted: boolean | null
          last_trade: string | null
          realized_pnl: number | null
          strategy_active: boolean | null
          strategy_id: string | null
          strategy_name: string | null
          trades_failed: number | null
          trades_filled: number | null
          trades_total: number | null
        }
        Relationships: []
      }
      agent_trades_pending_resolution: {
        Row: {
          earliest_entry: string | null
          ticker: string | null
          trade_ids: string[] | null
          trades_pending: number | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      append_excluded_city: {
        Args: { p_city: string; p_strategy: string }
        Returns: undefined
      }
      cron_health: {
        Args: never
        Returns: {
          active: boolean
          expected_interval_s: number
          is_stale: boolean
          jobname: string
          last_run_failed: boolean
          last_started_at: string
          last_status: string
          schedule: string
          seconds_since_last_run: number
        }[]
      }
      get_equity_curve: {
        Args: { p_mode?: string }
        Returns: {
          day: string
          day_pnl: number
        }[]
      }
      get_portfolio_summary: {
        Args: { p_mode?: string; p_today_start?: string }
        Returns: {
          last_settled_at: string
          losers: number
          open_positions: number
          settled_count: number
          starting_balance: number
          today_pnl: number
          total_pnl: number
          trades_today: number
          winners: number
        }[]
      }
      invoke_auto_reflect: { Args: never; Returns: undefined }
      upsert_rate_limit: {
        Args: {
          p_endpoint: string
          p_limit: number
          p_user_id: string
          p_window_start: string
        }
        Returns: boolean
      }
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
