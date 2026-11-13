-- Weekly AI-visibility tracker. Tables are private (RLS on, no policies);
-- dashboards read only through the token-checked functions at the bottom.

create table public.clients (
	id uuid primary key default gen_random_uuid(),
	slug text not null unique,
	name text not null,
	domain text not null,
	aliases text[] not null default '{}',
	-- [{ "name": "...", "domains": ["..."], "aliases": ["..."] }]
	competitors jsonb not null default '[]',
	prompts text[] not null default '{}',
	location_code integer not null default 2840,
	language_code text not null default 'en',
	include_openai boolean not null default true,
	active boolean not null default true,
	-- Secret in the dashboard link; rotate by setting a new value.
	share_token text not null unique default replace(gen_random_uuid()::text, '-', ''),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

-- One batch = one scrape of all of a client's prompts (e.g. "Monday 2026-11-16").
create table public.batches (
	id uuid primary key default gen_random_uuid(),
	client_id uuid not null references public.clients (id) on delete cascade,
	trigger text not null default 'scheduled', -- scheduled | manual
	started_at timestamptz not null default now(),
	finished_at timestamptz,
	runs_expected integer not null default 0,
	runs_failed integer not null default 0
);
create index on public.batches (client_id, started_at desc);

create table public.runs (
	id uuid primary key default gen_random_uuid(),
	batch_id uuid not null references public.batches (id) on delete cascade,
	client_id uuid not null references public.clients (id) on delete cascade,
	prompt text not null,
	provider text not null, -- chatgpt-scraped | openai-api
	model_version text,
	location_code integer,
	-- Named in the answer prose (links stripped).
	brand_mentioned boolean not null,
	-- Brand's own domain among the cited sources.
	brand_cited boolean not null,
	competitors_mentioned text[] not null default '{}',
	competitors_cited text[] not null default '{}',
	web_queries text[] not null default '{}',
	text_content text,
	created_at timestamptz not null default now()
);
create index on public.runs (batch_id);
create index on public.runs (client_id, created_at desc);

create table public.citations (
	id bigint generated always as identity primary key,
	run_id uuid not null references public.runs (id) on delete cascade,
	position integer not null,
	url text not null,
	domain text not null,
	title text
);
create index on public.citations (run_id);

-- Every page ChatGPT's web search surfaced (broader than what it cited).
create table public.search_results (
	id bigint generated always as identity primary key,
	run_id uuid not null references public.runs (id) on delete cascade,
	position integer not null,
	url text,
	domain text,
	title text,
	description text
);
create index on public.search_results (run_id);

alter table public.clients enable row level security;
alter table public.batches enable row level security;
alter table public.runs enable row level security;
alter table public.citations enable row level security;
alter table public.search_results enable row level security;
revoke all on public.clients, public.batches, public.runs, public.citations, public.search_results from anon, authenticated;

-- Everything one client's dashboard needs, for its last 52 batches.
create or replace function public.client_dashboard(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
	with c as (
		select * from clients where share_token = p_token
	),
	b as (
		select id, trigger, started_at, runs_expected, runs_failed
		from batches
		where client_id = (select id from c)
		order by started_at desc
		limit 52
	),
	r as (
		select * from runs where batch_id in (select id from b)
	)
	select case when not exists (select 1 from c) then null else jsonb_build_object(
		'client', (select jsonb_build_object(
			'name', name, 'domain', domain, 'competitors', competitors,
			'location_code', location_code, 'prompts', prompts
		) from c),
		'batches', coalesce((select jsonb_agg(to_jsonb(b) order by b.started_at) from b), '[]'::jsonb),
		'runs', coalesce((select jsonb_agg(jsonb_build_object(
			'id', r.id, 'batch_id', r.batch_id, 'prompt', r.prompt, 'provider', r.provider,
			'model_version', r.model_version, 'brand_mentioned', r.brand_mentioned,
			'brand_cited', r.brand_cited, 'competitors_mentioned', r.competitors_mentioned,
			'competitors_cited', r.competitors_cited, 'created_at', r.created_at
		)) from r), '[]'::jsonb),
		'citations', coalesce((select jsonb_agg(jsonb_build_object(
			'run_id', x.run_id, 'position', x.position, 'domain', x.domain, 'url', x.url, 'title', x.title
		)) from citations x where x.run_id in (select id from r)), '[]'::jsonb)
	) end;
$$;

-- Full answer + fan-out for one run, only if it belongs to the token's client.
create or replace function public.client_run_detail(p_token text, p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
	select jsonb_build_object(
		'text_content', r.text_content,
		'web_queries', r.web_queries,
		'search_results', coalesce((
			select jsonb_agg(jsonb_build_object('position', s.position, 'domain', s.domain, 'url', s.url, 'title', s.title) order by s.position)
			from search_results s where s.run_id = r.id
		), '[]'::jsonb)
	)
	from runs r
	join clients c on c.id = r.client_id
	where r.id = p_run_id and c.share_token = p_token;
$$;

revoke all on function public.client_dashboard(text), public.client_run_detail(text, uuid) from public;
grant execute on function public.client_dashboard(text), public.client_run_detail(text, uuid) to anon, authenticated;
