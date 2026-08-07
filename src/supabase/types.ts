export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      emails: {
        Row: {
          id: string;
          author_id: string;
          from_address: string;
          reply_to: string | null;
          subject: string;
          html: string;
          text: string | null;
          status: "draft" | "queued" | "sending" | "sent" | "failed" | "canceled";
          scheduled_at: string | null;
          sent_at: string | null;
          is_test: boolean | null;
          campaigns: string[];
          tags: string[];
          revision: number;
          last_snapshot_id: string | null;
          last_autosaved_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          author_id: string;
          from_address: string;
          reply_to?: string | null;
          subject: string;
          html: string;
          text?: string | null;
          status?: Database["public"]["Tables"]["emails"]["Row"]["status"];
          scheduled_at?: string | null;
          sent_at?: string | null;
          is_test?: boolean | null;
          campaigns?: string[];
          tags?: string[];
          revision?: number;
          last_snapshot_id?: string | null;
          last_autosaved_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["emails"]["Insert"]>;
        Relationships: [];
      };
      draft_snapshots: {
        Row: {
          id: string;
          email_id: string | null;
          author_id: string;
          revision: number;
          payload: Json;
          diff_summary: string | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          email_id: string | null;
          author_id: string;
          revision: number;
          payload: Json;
          diff_summary?: string | null;
          created_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["draft_snapshots"]["Insert"]>;
        Relationships: [];
      };
      error_logs: {
        Row: {
          id: string;
          user_id: string | null;
          source: string;
          message: string;
          stack: string | null;
          payload: Json | null;
          correlation_id: string | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          source: string;
          message: string;
          stack?: string | null;
          payload?: Json | null;
          correlation_id?: string | null;
          created_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["error_logs"]["Insert"]>;
        Relationships: [];
      };
      audit_logs: {
        Row: {
          id: string;
          user_id: string;
          action: string;
          entity: string | null;
          entity_id: string | null;
          payload: Json | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          action: string;
          entity?: string | null;
          entity_id?: string | null;
          payload?: Json | null;
          created_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["audit_logs"]["Insert"]>;
        Relationships: [];
      };
      mail_queue: {
        Row: {
          id: string;
          email_id: string | null;
          list_id: string | null;
          ses_message_id: string | null;
          payload: Json;
          status: "pending" | "processing" | "succeeded" | "failed" | "dead" | "canceled";
          attempts: number;
          max_attempts: number;
          dedupe_hash: string | null;
          rate_limit_bucket: string | null;
          available_at: string | null;
          locked_at: string | null;
          last_error: string | null;
          correlation_id: string | null;
          last_heartbeat: string | null;
          send_date: string | null;
          campaign_label: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          email_id?: string | null;
          list_id?: string | null;
          ses_message_id?: string | null;
          payload: Json;
          status?: Database["public"]["Tables"]["mail_queue"]["Row"]["status"];
          attempts?: number;
          max_attempts?: number;
          dedupe_hash?: string | null;
          rate_limit_bucket?: string | null;
          available_at?: string | null;
          locked_at?: string | null;
          last_error?: string | null;
          correlation_id?: string | null;
          last_heartbeat?: string | null;
          send_date?: string | null;
          campaign_label?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["mail_queue"]["Insert"]>;
        Relationships: [];
      };
      queue_metrics: {
        Row: {
          id: string;
          queue_depth: number;
          processed_count: number;
          failed_count: number;
          last_run_at: string | null;
        };
        Insert: {
          id?: string;
          queue_depth: number;
          processed_count: number;
          failed_count: number;
          last_run_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["queue_metrics"]["Insert"]>;
        Relationships: [];
      };
      feature_flags: {
        Row: {
          key: string;
          description: string | null;
          enabled: boolean;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          key: string;
          description?: string | null;
          enabled?: boolean;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["feature_flags"]["Insert"]>;
        Relationships: [];
      };
      admin_audit: {
        Row: {
          id: string;
          user_id: string;
          action: string;
          target: string | null;
          metadata: Json | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          action: string;
          target?: string | null;
          metadata?: Json | null;
          created_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["admin_audit"]["Insert"]>;
        Relationships: [];
      };
      provider_events: {
        Row: {
          id: string;
          provider: string;
          event_type: string;
          message_id: string | null;
          recipient: string | null;
          email_id: string | null;
          payload: Json;
          received_at: string | null;
        };
        Insert: {
          id?: string;
          provider?: string;
          event_type: string;
          message_id?: string | null;
          recipient?: string | null;
          email_id?: string | null;
          payload: Json;
          received_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["provider_events"]["Insert"]>;
        Relationships: [];
      };
      lists: {
        Row: {
          id: string;
          owner_id: string;
          name: string;
          address: string;
          description: string | null;
          mailgun_list_id: string | null;
          access_level: string | null;
          synced_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          owner_id: string;
          name: string;
          address: string;
          description?: string | null;
          mailgun_list_id?: string | null;
          access_level?: string | null;
          synced_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["lists"]["Insert"]>;
        Relationships: [];
      };
      list_members: {
        Row: {
          id: string;
          list_id: string | null;
          email: string;
          status: string | null;
          source: string | null;
          subscribed_at: string | null;
          unsubscribed_at: string | null;
          metadata: Json | null;
        };
        Insert: {
          id?: string;
          list_id?: string | null;
          email: string;
          status?: string | null;
          source?: string | null;
          subscribed_at?: string | null;
          unsubscribed_at?: string | null;
          metadata?: Json | null;
        };
        Update: Partial<Database["public"]["Tables"]["list_members"]["Insert"]>;
        Relationships: [];
      };
      files: {
        Row: {
          id: string;
          storage_path: string;
          mime_type: string | null;
          size_bytes: number | null;
          creator_id: string | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          storage_path: string;
          mime_type?: string | null;
          size_bytes?: number | null;
          creator_id?: string | null;
          created_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["files"]["Insert"]>;
        Relationships: [];
      };
      email_recipients: {
        Row: {
          id: string;
          email_id: string | null;
          recipient_address: string;
          status: string;
          last_event: string | null;
          metadata: Json | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          email_id?: string | null;
          recipient_address: string;
          status?: string;
          last_event?: string | null;
          metadata?: Json | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["email_recipients"]["Insert"]>;
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          email: string;
          role: string;
          can_send: boolean | null;
          created_at: string | null;
        };
        Insert: {
          id: string;
          email: string;
          role?: string;
          can_send?: boolean | null;
          created_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: {
      campaign_stats: {
        Row: {
          campaign_label: string;
          email_id: string;
          list_id: string | null;
          sent: number;
          failed: number;
          pending: number;
          started_at: string | null;
        };
      };
      email_send_stats: {
        Row: {
          email_id: string;
          list_ids: string[] | null;
          sent: number;
          failed: number;
          pending: number;
          first_sent: string | null;
          last_queued_at: string | null;
        };
      };
    };
    Functions: {
      claim_mail_queue_batch: {
        Args: {
          p_limit: number;
          p_email_id?: string | null;
          p_now?: string;
        };
        Returns: {
          id: string;
          email_id: string | null;
          payload: Json;
          list_id: string | null;
        }[];
      };
      get_queue_campaign_summaries: {
        Args: { p_email_ids: string[]; p_now?: string };
        Returns: Array<{
          email_id: string;
          list_id: string | null;
          pending_due: number;
          pending_held: number;
          processing: number;
          succeeded: number;
          failed: number;
          dead: number;
          canceled: number;
          total: number;
        }>;
      };
      mark_mail_queue_succeeded_batch: {
        Args: { p_results: Json; p_send_date: string; p_updated_at?: string };
        Returns: number;
      };
      release_mail_queue_campaign: {
        Args: {
          p_email_id: string;
          p_now: string;
          p_daily_limit: number;
          p_sent_today: number;
        };
        Returns: {
          released: number;
          due_now: number;
          scheduled_future: number;
        }[];
      };
    };
    Enums: Record<string, never>;
  };
}
