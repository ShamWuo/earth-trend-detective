-- Earth Trend Detective (ETG) — Optional Supabase Persistence Schema
-- Purely scientific Earth observation ontology: Concept, Signal, Insight, Rule

create table if not exists public.etg_nodes (
  uuid text primary key,
  label text not null check (label in ('Concept', 'Signal', 'Insight', 'Rule')),
  is_provisional boolean not null default false,
  properties jsonb not null default '{}'::jsonb,
  lat double precision generated always as ((properties->>'lat')::double precision) stored,
  lng double precision generated always as ((properties->>'lng')::double precision) stored,
  dataset text generated always as (properties->>'dataset') stored,
  observed_at timestamptz generated always as (
    case
      when properties->>'observed_at' is not null then (properties->>'observed_at')::timestamptz
      else null
    end
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_etg_nodes_label on public.etg_nodes (label);
create index if not exists idx_etg_nodes_dataset on public.etg_nodes (dataset);
create index if not exists idx_etg_nodes_observed_at on public.etg_nodes (observed_at);
create index if not exists idx_etg_nodes_geo on public.etg_nodes (lat, lng) where lat is not null and lng is not null;

create table if not exists public.etg_edges (
  uuid text primary key,
  source_uuid text not null references public.etg_nodes(uuid) on delete cascade,
  target_uuid text not null references public.etg_nodes(uuid) on delete cascade,
  type text not null check (
    type in (
      'supports',
      'corroborates',
      'drives_opposite',
      'correlates_with',
      'teleconnects',
      'verified_by',
      'supersedes',
      'monitors',
      'relates_to'
    )
  ),
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_etg_edges_source on public.etg_edges (source_uuid);
create index if not exists idx_etg_edges_target on public.etg_edges (target_uuid);
create index if not exists idx_etg_edges_type on public.etg_edges (type);

create table if not exists public.etg_webhook_events (
  id uuid primary key default gen_random_uuid(),
  node_uuid text not null references public.etg_nodes(uuid) on delete cascade,
  signal_uuid text references public.etg_nodes(uuid) on delete set null,
  producer_type text not null default 'iot_sensor',
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);
