// supabase/functions/_shared/paid.ts
// Texting, Outreach and Edit with AI cost money per use, so they are only for paid
// accounts: a row in paid_accounts (plans/paid-features.md, migration 022).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const NOT_ON_PLAN = "This feature isn't on your plan yet.";

export async function isPaid(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data } = await admin.from("paid_accounts").select("user_id").eq("user_id", userId).maybeSingle();
  return !!data;
}
