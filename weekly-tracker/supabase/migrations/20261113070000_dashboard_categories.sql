-- Per-client citation categories for the dashboard's Citations tab.
-- profile.domain_categories = { "<domain>": "<category>" } and profile.category_order = ["<category>", ...],
-- written by the aeo-data-analysis skill (save-insights.ts). Universal categories
-- (own site, competitor, government, institution, platform) are derived in the page.
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
