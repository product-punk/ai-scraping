-- Username/password login on one dashboard URL. Each user belongs to one client
-- and only ever sees that client's data. Replaces the per-client link token +
-- password. Passwords are bcrypt hashes; sessions are stored as SHA-256 hashes.

create table public.dashboard_users (
	id uuid primary key default gen_random_uuid(),
	client_id uuid not null references public.clients (id) on delete cascade,
	username text not null unique check (username = lower(username) and username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
	password_hash text not null,
	disabled boolean not null default false,
	failed_attempts integer not null default 0,
	locked_until timestamptz,
	last_login_at timestamptz,
	created_at timestamptz not null default now()
);
create index on public.dashboard_users (client_id);

create table public.dashboard_sessions (
	token_hash text primary key,
	user_id uuid not null references public.dashboard_users (id) on delete cascade,
	client_id uuid not null references public.clients (id) on delete cascade,
	expires_at timestamptz not null,
	created_at timestamptz not null default now()
);
create index on public.dashboard_sessions (expires_at);

alter table public.dashboard_users enable row level security;
alter table public.dashboard_sessions enable row level security;
revoke all on public.dashboard_users, public.dashboard_sessions from anon, authenticated;

-- ---------- Browser-callable: login / logout ----------

create or replace function public.dashboard_login(p_username text, p_password text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
	u dashboard_users%rowtype;
	raw_token text;
begin
	select * into u from dashboard_users where username = lower(trim(p_username)) for update;

	if not found or u.disabled then
		-- Same work and same answer as a wrong password, so usernames can't be probed.
		perform crypt(coalesce(p_password, ''), gen_salt('bf', 10));
		return '{"error":"invalid"}'::jsonb;
	end if;

	if u.locked_until is not null and u.locked_until > now() then
		return jsonb_build_object('error', 'locked', 'until', u.locked_until);
	end if;

	if p_password is null or u.password_hash <> crypt(p_password, u.password_hash) then
		update dashboard_users
		set failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
			locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
		where id = u.id;
		if u.failed_attempts + 1 >= 5 then
			return jsonb_build_object('error', 'locked', 'until', now() + interval '15 minutes');
		end if;
		return '{"error":"invalid"}'::jsonb;
	end if;

	update dashboard_users set failed_attempts = 0, locked_until = null, last_login_at = now() where id = u.id;
	delete from dashboard_sessions where expires_at < now();
	raw_token := encode(gen_random_bytes(32), 'hex');
	insert into dashboard_sessions (token_hash, user_id, client_id, expires_at)
	values (encode(digest(raw_token, 'sha256'), 'hex'), u.id, u.client_id, now() + interval '12 hours');
	return jsonb_build_object('session', raw_token, 'expires_at', now() + interval '12 hours', 'username', u.username);
end;
$$;

create or replace function public.dashboard_logout(p_session text)
returns void
language sql
volatile
security definer
set search_path = public, extensions
as $$
	delete from dashboard_sessions where token_hash = encode(digest(coalesce(p_session, ''), 'sha256'), 'hex');
$$;

-- Client for a live session (null when missing/expired/user disabled). Internal only.
create or replace function public.session_client(p_session text)
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
	select s.client_id
	from dashboard_sessions s
	join dashboard_users u on u.id = s.user_id
	where s.token_hash = encode(digest(coalesce(p_session, ''), 'sha256'), 'hex')
		and s.expires_at > now()
		and not u.disabled;
$$;
revoke all on function public.session_client(text) from public, anon, authenticated;

-- ---------- Browser-callable: data (session-gated) ----------

drop function if exists public.client_dashboard(text, text);
drop function if exists public.client_run_detail(text, uuid, text);
drop function if exists public.client_for(text, text);
drop function if exists public.set_client_password(text, text);
alter table public.clients drop column if exists dashboard_password_hash;
alter table public.clients drop column if exists share_token;

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

create or replace function public.client_run_detail(p_session text, p_run_id uuid)
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
	where r.id = p_run_id and r.client_id = session_client(p_session);
$$;

revoke all on function public.dashboard_login(text, text), public.dashboard_logout(text),
	public.client_dashboard(text), public.client_run_detail(text, uuid) from public;
grant execute on function public.dashboard_login(text, text), public.dashboard_logout(text),
	public.client_dashboard(text), public.client_run_detail(text, uuid) to anon, authenticated;

-- ---------- Server-only (service_role): user management ----------

create or replace function public.upsert_dashboard_user(p_client_slug text, p_username text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
	cid uuid;
begin
	if p_password is null or length(p_password) < 10 then
		raise exception 'password must be at least 10 characters';
	end if;
	select id into cid from clients where slug = p_client_slug;
	if cid is null then raise exception 'no client %', p_client_slug; end if;
	insert into dashboard_users (client_id, username, password_hash)
	values (cid, lower(trim(p_username)), crypt(p_password, gen_salt('bf', 10)))
	on conflict (username) do update
		set password_hash = excluded.password_hash, failed_attempts = 0, locked_until = null, disabled = false
		where dashboard_users.client_id = excluded.client_id;
	if not found then raise exception 'username % belongs to another client', p_username; end if;
	-- A reset signs the user out everywhere.
	delete from dashboard_sessions where user_id = (select id from dashboard_users where username = lower(trim(p_username)));
	return jsonb_build_object('username', lower(trim(p_username)), 'client', p_client_slug);
end;
$$;
revoke all on function public.upsert_dashboard_user(text, text, text) from public, anon, authenticated;
grant execute on function public.upsert_dashboard_user(text, text, text) to service_role;
