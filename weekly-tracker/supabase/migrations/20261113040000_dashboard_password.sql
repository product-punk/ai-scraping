-- Per-client dashboard password. Only a bcrypt hash is stored; the dashboard RPCs
-- return data only when both the link token and the password match.
create extension if not exists pgcrypto with schema extensions;

alter table public.clients add column dashboard_password_hash text;

-- Server-side only (service_role): set or clear (null) a client's password.
create or replace function public.set_client_password(p_slug text, p_password text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
	if p_password is not null and length(p_password) < 10 then
		raise exception 'password must be at least 10 characters';
	end if;
	update clients
	set dashboard_password_hash = case when p_password is null then null else crypt(p_password, gen_salt('bf', 10)) end,
		updated_at = now()
	where slug = p_slug;
	return found;
end;
$$;
revoke all on function public.set_client_password(text, text) from public, anon, authenticated;
grant execute on function public.set_client_password(text, text) to service_role;

-- Resolve a client from token + password; null when either is wrong.
create or replace function public.client_for(p_token text, p_password text)
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
	select id from clients
	where share_token = p_token
		and (dashboard_password_hash is null
			or (p_password is not null and dashboard_password_hash = crypt(p_password, dashboard_password_hash)));
$$;
revoke all on function public.client_for(text, text) from public, anon, authenticated;

drop function if exists public.client_dashboard(text);
drop function if exists public.client_run_detail(text, uuid);

-- Returns {"error":"password"} for a valid link with a missing/wrong password,
-- null for an unknown link, else the dashboard payload.
create or replace function public.client_dashboard(p_token text, p_password text default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
	with auth as (
		select client_for(p_token, p_password) as id
	),
	c as (
		select * from clients where id = (select id from auth)
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
	select case
		when (select id from auth) is null then
			case when exists (select 1 from clients where share_token = p_token) then '{"error":"password"}'::jsonb else null end
		else jsonb_build_object(
		'client', (select jsonb_build_object(
			'name', name, 'domain', domain, 'competitors', competitors,
			'location_code', location_code, 'prompts', prompts,
			'offerings', coalesce(profile -> 'offerings', '[]'::jsonb),
			'branding', coalesce(profile -> 'branding', '{}'::jsonb),
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

create or replace function public.client_run_detail(p_token text, p_run_id uuid, p_password text default null)
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
	where r.id = p_run_id and r.client_id = client_for(p_token, p_password);
$$;

revoke all on function public.client_dashboard(text, text), public.client_run_detail(text, uuid, text) from public;
grant execute on function public.client_dashboard(text, text), public.client_run_detail(text, uuid, text) to anon, authenticated;
