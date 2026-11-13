-- clients.active = "include this client in the Monday scrape". New clients start
-- off so nothing is spent until a client is switched on explicitly.
alter table public.clients alter column active set default false;
comment on column public.clients.active is 'Included in the scheduled weekly scrape (cost control). Dashboard access is unaffected.';
