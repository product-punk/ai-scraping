-- Client branding (colours + logo) for per-client dashboard theming.
-- Logos/icons are stored in a public bucket under the client's uuid (not its name).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
	'client-assets', 'client-assets', true, 2097152,
	array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/gif']
)
on conflict (id) do nothing;

-- profile.branding = { "primary": "#hex", "accent": "#hex", "dark": "#hex",
--   "icon_url": "...", "logo_url": "...", "source": "scraped|manual", "scraped_at": "..." }
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
		'insights', coalesce((select jsonb_agg(jsonb_build_object(
			'batch_id', i.batch_id, 'previous_batch_id', i.previous_batch_id, 'headline', i.headline,
			'summary', i.summary, 'content', i.content, 'created_at', i.created_at
		) order by i.created_at desc)
		from insights i where i.batch_id in (select id from b) and i.status = 'published'), '[]'::jsonb)
	) end;
$$;
