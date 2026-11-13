-- Weekly scraping switches, readable and (per client) writable from the dashboard.
-- Global master switch lives here instead of a GitHub variable so the dashboard can
-- show it and the Monday job can read it; only the server key may change it.

create table public.settings (
	key text primary key,
	value jsonb not null,
	updated_at timestamptz not null default now(),
	updated_by text
);
insert into public.settings (key, value, updated_by) values ('weekly_scrape_enabled', 'false', 'migration')
on conflict (key) do nothing;

-- Who switched a client's weekly scraping on or off, and when.
create table public.weekly_toggle_log (
	id bigint generated always as identity primary key,
	client_id uuid not null references public.clients (id) on delete cascade,
	username text not null,
	enabled boolean not null,
	created_at timestamptz not null default now()
);
create index on public.weekly_toggle_log (client_id, created_at desc);

alter table public.settings enable row level security;
alter table public.weekly_toggle_log enable row level security;
revoke all on public.settings, public.weekly_toggle_log from anon, authenticated;

create or replace function public.weekly_scrape_global()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
	select coalesce((select (value)::text::boolean from settings where key = 'weekly_scrape_enabled'), false);
$$;
revoke all on function public.weekly_scrape_global() from public, anon, authenticated;

-- A signed-in dashboard user switches weekly scraping for their own client only.
create or replace function public.client_set_weekly(p_session text, p_enabled boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
	sess record;
begin
	select s.client_id, u.username into sess
	from dashboard_sessions s
	join dashboard_users u on u.id = s.user_id
	where s.token_hash = encode(digest(coalesce(p_session, ''), 'sha256'), 'hex')
		and s.expires_at > now() and not u.disabled;
	if sess.client_id is null then
		return '{"error":"session"}'::jsonb;
	end if;
	update clients set active = coalesce(p_enabled, false), updated_at = now() where id = sess.client_id;
	insert into weekly_toggle_log (client_id, username, enabled) values (sess.client_id, sess.username, coalesce(p_enabled, false));
	return jsonb_build_object('enabled', coalesce(p_enabled, false), 'global', weekly_scrape_global());
end;
$$;
revoke all on function public.client_set_weekly(text, boolean) from public;
grant execute on function public.client_set_weekly(text, boolean) to anon, authenticated;

create or replace function public.client_dashboard(p_session text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
	with c as (
		select * from clients where id = session_client(p_session)
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
	select case when not exists (select 1 from c) then '{"error":"session"}'::jsonb else jsonb_build_object(
		'client', (select jsonb_build_object(
			'name', name, 'domain', domain, 'competitors', competitors,
			'location_code', location_code, 'prompts', prompts,
			'offerings', coalesce(profile -> 'offerings', '[]'::jsonb),
			'branding', coalesce(profile -> 'branding', '{}'::jsonb),
			'domain_categories', coalesce(profile -> 'domain_categories', '{}'::jsonb),
			'category_order', coalesce(profile -> 'category_order', '[]'::jsonb),
			'prompt_tags', prompt_tags,
			-- Weekly switch for this client, plus whether weekly runs happen at all.
			'weekly', jsonb_build_object('enabled', active, 'global', weekly_scrape_global())
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
		'fanout', coalesce((select jsonb_agg(jsonb_build_object(
			'run_id', s.run_id, 'domain', s.domain, 'url', s.url
		)) from search_results s where s.run_id in (select id from r)), '[]'::jsonb),
		'insights', coalesce((select jsonb_agg(jsonb_build_object(
			'batch_id', i.batch_id, 'previous_batch_id', i.previous_batch_id, 'headline', i.headline,
			'summary', i.summary, 'content', i.content, 'created_at', i.created_at
		) order by i.created_at desc)
		from insights i where i.batch_id in (select id from b) and i.status = 'published'), '[]'::jsonb)
	) end;
$$;
