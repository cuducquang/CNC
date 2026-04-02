-- CNC Part Costing - Approach 1 Database Schema
-- Run this in the Supabase SQL Editor to set up your database

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Analyses table
create table if not exists analyses (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  file_name text not null,
  file_3d_path text,
  file_2d_path text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'error')),
  feature_recognition jsonb,
  process_mapping jsonb,
  cycle_time jsonb,
  cost_estimation jsonb,
  dimension_gdt jsonb,
  error_message text,
  agent_log jsonb
);

-- Index for faster queries
create index if not exists idx_analyses_status on analyses(status);
create index if not exists idx_analyses_created_at on analyses(created_at desc);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger analyses_updated_at
  before update on analyses
  for each row
  execute function update_updated_at();

-- Row Level Security
alter table analyses enable row level security;

-- Allow all operations for now (adjust for production with auth)
create policy "Allow all operations on analyses"
  on analyses
  for all
  using (true)
  with check (true);

-- Create storage bucket for part files
-- Note: Run this separately or via Supabase dashboard:
-- 1. Go to Storage > Create new bucket
-- 2. Name: "parts"
-- 3. Set as public bucket (or configure RLS policies)
