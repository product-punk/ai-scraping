-- Client analysis context + weekly insights written by the aeo-data-analysis skill.

-- { "business_type": "service", "offerings": [{"name": "...", "keywords": ["..."]}],
--   "brand_colors": {"primary": "#...", "accent": "#...", "dark": "#..."}, "notes": "..." }
alter table public.clients add column profile jsonb not null default '{}';
-- { "<prompt text>": { "offering": "...", "intent": "commercial|informational|branded" } }
alter table public.clients add column prompt_tags jsonb not null default '{}';

create table public.insights (
	id uuid primary key default gen_random_uuid(),
	client_id uuid not null references public.clients (id) on delete cascade,
	batch_id uuid not null references public.batches (id) on delete cascade,
	previous_batch_id uuid references public.batches (id) on delete set null,
	status text not null default 'published', -- draft | published
	generated_by text not null default 'aeo-data-analysis',
	headline text not null,
	summary text,
	-- metrics (overall / by_source / by_offering), findings[], actions[], competitors[], outreach[]
	content jsonb not null default '{}',
	report_file text,
	created_at timestamptz not null default now(),
	unique (batch_id, status)
);
create index on public.insights (client_id, created_at desc);
alter table public.insights enable row level security;
revoke all on public.insights from anon, authenticated;

-- Dashboard payload now also carries published insights for the batches it returns.
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
			'location_code', location_code, 'prompts', prompts,
			'offerings', coalesce(profile -> 'offerings', '[]'::jsonb),
			'brand_colors', coalesce(profile -> 'brand_colors', '{}'::jsonb),
			'prompt_tags', prompt_tags
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
		)) from citations x where x.run_id in (select id from r)), '[]'::jsonb),
		'insights', coalesce((select jsonb_agg(jsonb_build_object(
			'batch_id', i.batch_id, 'previous_batch_id', i.previous_batch_id, 'headline', i.headline,
			'summary', i.summary, 'content', i.content, 'created_at', i.created_at
		) order by i.created_at desc)
		from insights i where i.batch_id in (select id from b) and i.status = 'published'), '[]'::jsonb)
	) end;
$$;
