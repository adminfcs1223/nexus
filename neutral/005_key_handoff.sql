-- Temporary pickup for a newly issued key: the plaintext waits here until its owner copies it into their own server-side
-- secret, then the row is deleted. Not exposed through any API. Backups never include these rows (see ops/backup.sh).
create table nexus.key_handoff (label text primary key, env_name text not null, key text not null, created_at timestamptz not null default now());
alter table nexus.key_handoff enable row level security;
